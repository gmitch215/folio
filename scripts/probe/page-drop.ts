import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, hostname, loadavg } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
	bakeModule,
	captureImage,
	checkBaked,
	decodeImage,
	encodeImage,
	moduleDigest,
	type MemoryImage
} from '../../src/bake.ts';
import { judge, scanImage, type Secret } from '../analyze/bakesecrets.ts';
import {
	bisectPoison,
	checkAllocator,
	classifyPages,
	dropPages,
	equalRuns,
	judgeTrial,
	labelRanges,
	largestFree,
	maskOf,
	normalizeBody,
	pageBytes,
	parseMask,
	runsOf,
	summarizeClasses,
	walkHeap,
	type Layout,
	type PageClass,
	type Step,
	type Trial
} from '../analyze/pagedrop.ts';
import { differingPages, readStoredHeap } from './product-bake.ts';

const usage = `usage: node scripts/probe/page-drop.ts MODE ROWS.jsonl ARGS
  classify SNAPSHOT.sqlite DUMP.bin META.json OUTDIR   label every delta page, write full.image
  sound DUMP.bin OUTDIR                                drop by the allocator rule, bake, check
  scan OUTDIR IMAGE.image SECRETS.txt...               findInImage counts of throwaway secrets
  render PORTS                                         one render set per port against the plain arm
  poison OUTDIR                                        poison search over the delta pages
  empirical DUMP.bin OUTDIR                            bake the image without the pages poison cleared
  cold LABEL PORT N                                    N cold objects, first request wall time
INTERP names the directory with the pinned php.wasm and glue.mjs; PORTS is a comma list`;

const pinnedWasm = '95447d3dd001ccbdbb392a6f5f64210380712a76cf22b00487333277414ba6e4';
const pinnedGlue = 'c815ae66de8af38b9e206c42740030f76aa52c4842f3430c7a59f734333edaad';
const root = new URL('../../', import.meta.url).pathname;
const interpDir = process.env.INTERP ?? `${root}experiments/consumer/build/php`;
const gm = 4_237_888;
const [mode, output, ...rest] = process.argv.slice(2);

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const wasm = new Uint8Array(readFileSync(`${interpDir}/php.wasm`));
const interp = { wasmSha256: sha(wasm), glueSha256: sha(readFileSync(`${interpDir}/glue.mjs`)) };
if (interp.wasmSha256 !== pinnedWasm || interp.glueSha256 !== pinnedGlue) {
	console.error(`interpreter changed: ${JSON.stringify(interp)}`);
	process.exit(3);
}

const machine =
	process.env.FOLIO_MACHINE ?? `${hostname()} (${cpus()[0]?.model}, ${cpus().length} cpus)`;
type Row = Record<string, any>;
const emit = (row: Row): Row => {
	const line = {
		...row,
		...interp,
		machine,
		node: process.version,
		load: loadavg(),
		at: Date.now()
	};
	if (output) appendFileSync(output, `${JSON.stringify(line)}\n`);
	return line;
};
const mib = (bytes: number) => Math.round((bytes / 1_048_576) * 100) / 100;

// #region memory helpers

function stubImports(module: WebAssembly.Module, memory: WebAssembly.Memory) {
	const imports: Record<string, Record<string, unknown>> = {};
	for (const item of WebAssembly.Module.imports(module)) {
		imports[item.module] ??= {};
		imports[item.module]![item.name] =
			item.kind === 'memory'
				? memory
				: item.kind === 'global'
					? new WebAssembly.Global({ value: 'i32', mutable: true }, 0)
					: () => 0;
	}
	return imports as WebAssembly.Imports;
}

/** the memory an instance of `bytes` has before anything runs: the module's own data only */
function instantiated(bytes: Uint8Array, pages: number): Uint8Array {
	const module = new WebAssembly.Module(bytes as BufferSource);
	const memory = new WebAssembly.Memory({ initial: pages, maximum: 65_536 });
	new WebAssembly.Instance(module, stubImports(module, memory));
	return new Uint8Array(memory.buffer);
}

/** the first mutable i32 global's initial value, which is the stack pointer of an emscripten build */
function initialStackPointer(bytes: Uint8Array): number {
	let at = 8;
	const leb = (signed: boolean) => {
		let result = 0;
		let shift = 0;
		let byte: number;
		do {
			byte = bytes[at++]!;
			result |= (byte & 0x7f) << shift;
			shift += 7;
		} while (byte & 0x80);
		if (signed && shift < 32 && byte & 0x40) result |= -1 << shift;
		return signed ? result | 0 : result >>> 0;
	};
	while (at < bytes.length) {
		const id = bytes[at++]!;
		const size = leb(false);
		const end = at + size;
		if (id === 6) {
			for (let n = leb(false); n > 0; n--) {
				at++;
				const mutable = bytes[at++] === 1;
				const op = bytes[at++];
				if (mutable && op === 0x41) return leb(true);
				at = end;
				break;
			}
		}
		at = end;
	}
	throw new Error('no mutable i32 global');
}

function loadCapture(dump: string) {
	const mem = new Uint8Array(readFileSync(dump));
	const fresh = instantiated(wasm, 1024);
	const walk = walkHeap(mem, gm);
	const ranges = labelRanges(walk);
	const stackTop = initialStackPointer(wasm);
	const layout: Layout = { dataEnd: stackTop - 32 * 1_048_576, stackTop, heapEnd: walk.end };
	return { mem, fresh, walk, ranges, layout };
}

// #endregion

async function classify(sqlite: string, dump: string, metaFile: string, out: string) {
	mkdirSync(out, { recursive: true });
	const copy = `${out}/snapshot.sqlite`;
	copyFileSync(sqlite, copy);
	for (const ext of ['-wal', '-shm']) {
		try {
			copyFileSync(sqlite + ext, copy + ext);
		} catch {
			// no pending wal
		}
	}
	const db = new DatabaseSync(copy, { readOnly: true });
	const stored = readStoredHeap(db);
	db.close();
	const dumpBytes = new Uint8Array(readFileSync(dump));
	const { mem, fresh, walk, ranges, layout } = loadCapture(dump);
	const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
	const digest = await moduleDigest(wasm);
	const image = captureImage(mem, fresh, {
		module: digest,
		context: `${meta.context}|module=${digest}`
	});
	writeFileSync(`${out}/full.image`, encodeImage(image));
	const rows = classifyPages(mem, fresh, ranges, layout, image.pages);
	const summary = summarizeClasses(rows, walk, ranges);
	writeFileSync(`${out}/classes.json`, JSON.stringify(rows));
	const stackPages = rows.filter((row) => row.region === 'stack').map((row) => row.page);
	return emit({
		kind: 'classify',
		image: `${image.pages.length} delta pages of ${image.byteLength / pageBytes}`,
		snapshotEqualsDump: differingPages(stored.heap, dumpBytes) === 0,
		snapshotBytes: stored.heap.length,
		allocator: {
			name: 'dlmalloc 2.8 (32-bit), state at',
			state: gm,
			...checkAllocator(mem, gm)
		},
		layout,
		largestFreeChunks: largestFree(walk, 8),
		mixedPages: rows
			.filter((row: PageClass) => row.region === 'heap' && row.outside > 0)
			.map((row) => ({ page: row.page, outsideBytes: row.outside })),
		stackPages,
		equalRuns: [64, 256, 1024, 4096, 16_384].map((minRun) =>
			equalRuns(mem, fresh, image.pages, minRun)
		),
		summary
	});
}

/** bakes the full image minus `chosen` (default: the pages the allocator rule drops) and checks the replay */
async function bake(dump: string, out: string, name: string, chosen?: Set<number>) {
	const { mem, fresh, walk, ranges, layout } = loadCapture(dump);
	const full = decodeImage(new Uint8Array(readFileSync(`${out}/full.image`)));
	const rows = classifyPages(mem, fresh, ranges, layout, full.pages);
	const drop = chosen ?? new Set(rows.filter((row) => row.droppable).map((row) => row.page));
	const strict = new Set(rows.filter((row) => row.strict).map((row) => row.page));
	const image = dropPages(full, drop);
	const baked = await bakeModule(wasm, image);
	writeFileSync(`${out}/${name}.image`, encodeImage(image));
	writeFileSync(`${out}/${name}.wasm`, baked);
	const check = checkBaked(baked, image);
	const replayed = instantiated(baked, image.byteLength / pageBytes);
	let differs = 0;
	let differsOutsideDropped = 0;
	let droppedNotFresh = 0;
	let droppedOutsideFreeBytes = 0;
	const free = ranges.filter((range) => range.cls === 'free' || range.cls === 'top');
	for (let page = 0; page < image.byteLength / pageBytes; page++) {
		const start = page * pageBytes;
		const isDropped = drop.has(page);
		for (let i = 0; i < pageBytes; i++) {
			const at = start + i;
			if (replayed[at] === mem[at]) continue;
			differs++;
			if (!isDropped) differsOutsideDropped++;
		}
		if (isDropped)
			for (let i = 0; i < pageBytes; i++)
				if (replayed[start + i] !== (fresh[start + i] ?? 0)) droppedNotFresh++;
	}
	for (const page of drop) {
		const start = page * pageBytes;
		const end = start + pageBytes;
		const inside = free.some((range) => range.start <= start && range.end >= end);
		if (!inside && !strict.has(page)) droppedOutsideFreeBytes++;
	}
	const after = walkHeap(replayed, gm);
	const same =
		after.chunks.length === walk.chunks.length &&
		after.chunks.every((chunk, i) => {
			const was = walk.chunks[i]!;
			return chunk.at === was.at && chunk.size === was.size && chunk.kind === was.kind;
		});
	return emit({
		kind: 'drop',
		name,
		deltaPages: full.pages.length,
		droppedPages: drop.size,
		droppedStrict: strict.size,
		droppedRuns: runsOf([...drop].sort((a, b) => a - b)),
		keptPages: image.pages.length,
		keptBytes: image.pages.length * pageBytes,
		fullBakedBytes: 63_930_069,
		bakedBytes: baked.length,
		plainBytes: 13_401_751,
		checkEqual: check.equal,
		bytesDifferAfterReplay: differs,
		bytesDifferOutsideDroppedPages: differsOutsideDropped,
		droppedBytesNotFresh: droppedNotFresh,
		droppedPagesNotInsideFreeBytes: droppedOutsideFreeBytes,
		allocator: checkAllocator(replayed, gm),
		chunkWalkEqual: same,
		allocatorOk: checkAllocator(replayed, gm).ok && same,
		droppedReadFresh: droppedNotFresh === 0
	});
}

const readSecrets = (files: string[]): Secret[] =>
	files.flatMap((file) =>
		readFileSync(file, 'utf8')
			.trim()
			.split(' ')
			.map((value, i) => ({
				name: `${file.split('/').at(-1)}#${i}`,
				bytes: new TextEncoder().encode(value),
				expect: 'info' as const
			}))
	);

function scan(out: string, imageFile: string, files: string[]) {
	const image: MemoryImage = decodeImage(new Uint8Array(readFileSync(imageFile)));
	const secrets = readSecrets(files);
	const results = judge(scanImage(image, secrets), secrets);
	return emit({
		kind: 'scan',
		image: imageFile.split('/').at(-1),
		pages: image.pages.length,
		results: results.map((result) => ({
			secret: result.secret,
			total: result.total,
			forms: result.forms
		}))
	});
}

// #region render set

const throwaway = {
	key: Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url'),
	salt: Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url')
};
const requestMs = Number(process.env.REQUEST_MS ?? 45_000);
const sequence = [
	'/',
	'/user/login',
	'/filter/tips',
	'/this-page-does-not-exist',
	'/',
	'/',
	'invalidate',
	'/'
];
let counter = 0;
const wedgedText = /TimeoutError|aborted/;
const deadText = /fetch failed|ECONNREFUSED|ECONNRESET/;

async function getJson(url: string): Promise<any> {
	const response = await fetch(url, { signal: AbortSignal.timeout(requestMs) });
	return response.json();
}

const siteName = () => `pd${Date.now().toString(36)}${counter++}`;

async function prepare(base: string, site: string) {
	await getJson(`${base}/migrate?site=${site}&all=1`);
	await getJson(`${base}/migrate?site=${site}&all=1`);
	await getJson(`${base}/hostseed?site=${site}&key=${throwaway.key}&salt=${throwaway.salt}`);
}

/** one cold object: migrate, seed a throwaway key and salt, then the render set; `mask` poisons the first boot */
async function renderSet(
	port: number,
	mask: string | null
): Promise<Trial & { wedged?: boolean; dead?: boolean }> {
	const base = `http://127.0.0.1:${port}`;
	const site = siteName();
	const t0 = Date.now();
	const steps: Step[] = [];
	let boot: unknown;
	try {
		await prepare(base, site);
		for (const [i, path] of sequence.entries()) {
			if (path === 'invalidate') {
				const out = await getJson(`${base}/invalidate?site=${site}&tags=rendered`);
				const sha = String(out.generationAfter);
				steps.push({ step: path, status: out.ok ? 200 : 500, bytes: 0, sha });
				continue;
			}
			const poison = i === 0 && mask !== null ? `&pdp=${encodeURIComponent(mask)}` : '';
			const out = await getJson(
				`${base}/hostbody?site=${site}&path=${encodeURIComponent(path)}${poison}`
			);
			if (i === 0) boot = out.boot;
			const run = out.php?.runs?.[0];
			if (!run || typeof run.body !== 'string') {
				const sha = `no body: ${JSON.stringify(out).slice(0, 80)}`;
				steps.push({ step: path, status: 0, bytes: 0, sha });
				return { pass: false, steps, failed: path, wallMs: Date.now() - t0, boot };
			}
			steps.push({
				step: path,
				status: run.status,
				bytes: run.bytes,
				sha: sha(normalizeBody(run.body)).slice(0, 16)
			});
		}
	} catch (error) {
		const at = sequence[steps.length] ?? 'setup';
		const sha = `error: ${String(error).slice(0, 80)}`;
		steps.push({ step: at, status: 0, bytes: 0, sha });
		const wedged = wedgedText.test(String(error));
		const dead = deadText.test(String(error));
		return { pass: false, steps, failed: at, wallMs: Date.now() - t0, boot, wedged, dead };
	}
	return { pass: true, steps, wallMs: Date.now() - t0, boot };
}

const portsOf = (name: string) => (process.env[name] ?? '').split(',').filter(Boolean).map(Number);

/** hands out the baked servers one at a time; a wedged server is restarted before it is handed out again */
function pool(ports: number[]) {
	const idle = [...ports];
	const waiting: ((port: number) => void)[] = [];
	const give = (port: number) => {
		const next = waiting.shift();
		if (next) next(port);
		else idle.push(port);
	};
	return async function run<T>(
		use: (port: number) => Promise<T & { wedged?: boolean; dead?: boolean }>
	): Promise<T> {
		const port =
			idle.shift() ?? (await new Promise<number>((resolve) => waiting.push(resolve)));
		try {
			const result = await use(port);
			if ((result.wedged || result.dead) && process.env.RESTART) {
				spawnSync(process.env.RESTART, [String(port)], { stdio: 'inherit' });
			}
			return result;
		} finally {
			give(port);
		}
	};
}

function trialRow(phase: string, port: number, set: number[] | null, trial: Trial) {
	return emit({
		kind: 'trial',
		phase,
		port,
		pages: set?.length ?? null,
		first: set?.[0],
		last: set?.at(-1),
		maskSha: set ? sha(maskOf(set)).slice(0, 12) : null,
		pass: trial.pass,
		failed: trial.failed,
		wallMs: trial.wallMs,
		boot: trial.boot,
		steps: trial.steps
	});
}

async function reference(plain: number) {
	const a = await renderSet(plain, null);
	const b = await renderSet(plain, null);
	trialRow('reference-plain-1', plain, null, a);
	trialRow('reference-plain-2', plain, null, b);
	const same =
		a.pass &&
		b.pass &&
		a.steps.every((s, i) => s.status === b.steps[i]!.status && s.sha === b.steps[i]!.sha);
	if (!same) throw new Error('the plain arm is not deterministic under the normalizer');
	return a.steps;
}

/** the baked server with no poison against the plain reference, twice */
async function baseline(ports: number[], plain: number) {
	const ref = await reference(plain);
	const run = pool(ports);
	const trials = await Promise.all(
		[0, 1].map((i) =>
			run(async (port) => {
				const trial = judgeTrial(await renderSet(port, ''), ref);
				trialRow(`baseline-baked-${i}`, port, [], trial);
				return trial;
			})
		)
	);
	return { ref, pass: trials.every((trial) => trial.pass) };
}

type Pool = ReturnType<typeof pool>;

/** one judged trial of `set`; a dead server is restarted and the trial runs again, up to three times */
async function attempt(run: Pool, phase: string, set: number[], ref: Step[]) {
	for (let tries = 0; ; tries++) {
		const trial = await run(async (port) => {
			const result = judgeTrial(await renderSet(port, maskOf(set)), ref);
			trialRow(phase, port, set, result);
			return result;
		});
		if (!(trial as { dead?: boolean }).dead || tries >= 2) return trial;
	}
}

async function poison(out: string) {
	const ports = portsOf('PORTS');
	const [plain] = portsOf('PLAIN_PORT');
	const classes: PageClass[] = JSON.parse(readFileSync(`${out}/classes.json`, 'utf8'));
	const candidates = classes.map((row) => row.page);
	const base = await baseline(ports, plain!);
	if (!base.pass) throw new Error('baked boot without poison differs from the plain arm');
	const run = pool(ports);
	const found = await bisectPoison(
		candidates,
		async (set) => (await attempt(run, 'search', set, base.ref)).pass
	);
	const confirm = await Promise.all(
		[0, 1, 2].map((i) => attempt(run, `confirm-${i}`, found.kept, base.ref))
	);
	writeFileSync(
		`${out}/poison.json`,
		JSON.stringify({ kept: found.kept, bad: found.bad, tries: found.tries })
	);
	return emit({
		kind: 'poison',
		candidates: candidates.length,
		clearedPages: found.kept.length,
		neededPages: found.bad.length,
		tries: found.tries,
		confirm: confirm.map((trial) => trial.pass),
		clearedRuns: runsOf(found.kept).length,
		classesOfCleared: Object.fromEntries(
			['data', 'stack', 'heap'].map((region) => [
				region,
				classes.filter((row) => row.region === region && found.kept.includes(row.page))
					.length
			])
		)
	});
}

/** the render set against one server, no poison, as the check of a module with pages really dropped */
async function check(label: string, port: number, plain: number) {
	const ref = await reference(plain);
	const runs: boolean[] = [];
	for (let i = 0; i < 3; i++) {
		const trial = judgeTrial(await renderSet(port, ''), ref);
		trialRow(`check-${label}-${i}`, port, null, trial);
		runs.push(trial.pass);
	}
	const probe = async (at: number) => {
		const site = siteName();
		await prepare(`http://127.0.0.1:${at}`, site);
		await getJson(
			`http://127.0.0.1:${at}/hostbody?site=${site}&path=${encodeURIComponent('/')}&pdp=`
		);
		const out = await getJson(`http://127.0.0.1:${at}/hostprobe?site=${site}&what=csrf`);
		return out.probe as { token: string; key: string; salt: string };
	};
	const [baked, plainProbe, other] = [await probe(port), await probe(plain), await probe(port)];
	return emit({
		kind: 'check',
		label,
		runs,
		rekey: {
			tokenEqualsPlain: baked.token === plainProbe.token,
			keyHashEqualsPlain: baked.key === plainProbe.key,
			saltHashEqualsPlain: baked.salt === plainProbe.salt,
			secondObjectTokenEqual: baked.token === other.token
		}
	});
}

async function cold(label: string, port: number, count: number) {
	const base = `http://127.0.0.1:${port}`;
	const rows: Row[] = [];
	for (let i = 0; i < count; i++) {
		const site = siteName();
		await prepare(base, site);
		const load = loadavg()[0];
		const t0 = performance.now();
		const first = await getJson(
			`${base}/hostbody?site=${site}&path=${encodeURIComponent('/')}`
		);
		const wallMs = performance.now() - t0;
		const t1 = performance.now();
		const again = await getJson(
			`${base}/hostbody?site=${site}&path=${encodeURIComponent('/')}&pdp=`
		);
		const rebootWallMs = performance.now() - t1;
		rows.push(
			emit({
				kind: 'cold',
				label,
				port,
				index: i,
				load1: load,
				firstWallMs: Math.round(wallMs),
				firstRenderMs: first.php?.runs?.[0]?.ms,
				firstBytes: first.php?.runs?.[0]?.bytes,
				warmInterpreter: first.php?.warmInterpreter,
				boot: first.boot,
				rebootWallMs: Math.round(rebootWallMs),
				rebootRenderMs: again.php?.runs?.[0]?.ms,
				rebootBoot: again.boot,
				sha: sha(normalizeBody(first.php?.runs?.[0]?.body ?? '')).slice(0, 16)
			})
		);
	}
	return rows;
}

// #endregion

if (mode === 'classify') {
	const [sqlite, dump, meta, out] = rest;
	console.log(JSON.stringify((await classify(sqlite!, dump!, meta!, out!)).summary, null, 1));
} else if (mode === 'sound') {
	const [dump, out] = rest;
	console.log(JSON.stringify(await bake(dump!, out!, 'sound'), null, 1));
} else if (mode === 'scan') {
	const [out, image, ...files] = rest;
	console.log(JSON.stringify(scan(out!, image!, files), null, 1));
} else if (mode === 'poison') {
	console.log(JSON.stringify(await poison(rest[0]!), null, 1));
} else if (mode === 'empirical') {
	const [dump, out] = rest;
	const { kept } = JSON.parse(readFileSync(`${out}/poison.json`, 'utf8')) as { kept: number[] };
	console.log(JSON.stringify(await bake(dump!, out!, 'empirical', new Set(kept)), null, 1));
} else if (mode === 'check') {
	const [label, port] = rest;
	const [plain] = portsOf('PLAIN_PORT');
	console.log(JSON.stringify(await check(label!, Number(port), plain!), null, 1));
} else if (mode === 'cold') {
	const [label, port, count] = rest;
	console.log(JSON.stringify(await cold(label!, Number(port), Number(count)), null, 1));
} else if (mode === 'try') {
	const [plain] = portsOf('PLAIN_PORT');
	const ref = await reference(plain!);
	const trial = judgeTrial(await renderSet(portsOf('PORTS')[0]!, rest[0]!), ref);
	trialRow('try', portsOf('PORTS')[0]!, parseMask(rest[0]!), trial);
	console.log(JSON.stringify(trial));
} else if (mode === 'bundle') {
	const [label, dir] = rest;
	const run = spawnSync(
		'npx',
		['wrangler', 'deploy', '--dry-run', '-c', 'wrangler.deploy.jsonc', '--outdir', 'dry'],
		{ cwd: dir, encoding: 'utf8' }
	);
	const total = /Total Upload: ([\d.]+) KiB/.exec(`${run.stdout}${run.stderr}`);
	if (!total) throw new Error('no Total Upload line');
	const moduleBytes = readFileSync(`${dir}/.interp/php8.5.tuned.wasm`).length;
	const totalUploadKiB = Number(total[1]);
	const limitMiB = 63.9;
	console.log(
		JSON.stringify(
			emit({
				kind: 'bundle',
				label,
				moduleBytes,
				totalUploadKiB,
				nonModuleKiB: Math.round((totalUploadKiB - moduleBytes / 1024) * 100) / 100,
				limitMiB,
				overLimitKiB: Math.round((totalUploadKiB - limitMiB * 1024) * 100) / 100
			})
		)
	);
} else if (mode === 'prefix') {
	const [plain] = portsOf('PLAIN_PORT');
	const [port] = portsOf('PORTS');
	const ref = await reference(plain!);
	const { kept } = JSON.parse(readFileSync(`${rest[0]}/poison.json`, 'utf8')) as {
		kept: number[];
	};
	const passes = async (n: number) => {
		const set = kept.slice(0, n);
		const trial = judgeTrial(await renderSet(port!, maskOf(set)), ref);
		trialRow('prefix', port!, set, trial);
		return trial.pass;
	};
	let lo = 0;
	let hi = kept.length;
	while (lo + 1 < hi) {
		const mid = (lo + hi) >> 1;
		if (await passes(mid)) lo = mid;
		else hi = mid;
	}
	console.log(
		JSON.stringify({ longestPassingPrefix: lo, tippingPage: kept[lo], of: kept.length })
	);
} else if (mode === 'greedy') {
	const [plain] = portsOf('PLAIN_PORT');
	const run = pool(portsOf('PORTS'));
	const ref = await reference(plain!);
	const poisonFile = `${rest[0]}/poison.json`;
	const found = JSON.parse(readFileSync(poisonFile, 'utf8')) as { kept: number[] };
	let set: number[] = [];
	let refused = 0;
	for (const [a, b] of runsOf(found.kept)) {
		const add = Array.from({ length: b - a + 1 }, (_, i) => a + i);
		const next = [...set, ...add];
		if ((await attempt(run, 'greedy', next, ref)).pass) set = next;
		else refused += add.length;
	}
	const confirm = await Promise.all(
		[0, 1, 2].map((i) => attempt(run, `confirm-greedy-${i}`, set, ref))
	);
	writeFileSync(poisonFile, JSON.stringify({ ...found, searchKept: found.kept, kept: set }));
	console.log(
		JSON.stringify(
			emit({
				kind: 'greedy',
				searchKeptPages: found.kept.length,
				clearedPages: set.length,
				refusedPages: refused,
				confirm: confirm.map((trial) => trial.pass)
			})
		)
	);
} else if (mode === 'reverify') {
	const [plain] = portsOf('PLAIN_PORT');
	const run = pool(portsOf('PORTS'));
	const ref = await reference(plain!);
	const poisonFile = `${rest[0]}/poison.json`;
	const found = JSON.parse(readFileSync(poisonFile, 'utf8')) as { kept: number[]; bad: number[] };
	const again = await Promise.all(
		found.bad.map(async (page) => ({
			page,
			pass: (await attempt(run, 'reverify', [page], ref)).pass
		}))
	);
	const flipped = again.filter((row) => row.pass).map((row) => row.page);
	let set = found.kept;
	let refused = 0;
	for (const page of flipped) {
		const next = [...set, page].sort((a, b) => a - b);
		if ((await attempt(run, 'reverify-add', next, ref)).pass) set = next;
		else refused++;
	}
	const confirm = await Promise.all(
		[0, 1, 2].map((i) => attempt(run, `confirm-reverify-${i}`, set, ref))
	);
	writeFileSync(poisonFile, JSON.stringify({ ...found, kept: set, flipped }));
	console.log(
		JSON.stringify(
			emit({
				kind: 'reverify',
				rechecked: found.bad.length,
				flipped: flipped.length,
				addedPages: set.length - found.kept.length,
				refusedPages: refused,
				clearedPages: set.length,
				confirm: confirm.map((trial) => trial.pass)
			})
		)
	);
} else if (mode === 'baseline') {
	const [plain] = portsOf('PLAIN_PORT');
	console.log(JSON.stringify(await baseline(portsOf('PORTS'), plain!), null, 1));
} else {
	console.error(usage);
	process.exit(2);
}
