import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { cpus, loadavg } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { bakeModule, captureImage, checkBaked, type MemoryImage } from '../../src/bake.ts';
import { consumerRoot, resolveConsumer } from './consumer-root.ts';

// can a booted Drupal heap reach a new instance faster than the interpreter boots? One script, two
// roles: the plain node process drives and builds modules (binaryen); the same file bundled with
// the consumer's sources runs as the child that boots contexts and times deliveries.
// usage: node scripts/probe/boot-image.ts MODE OUTPUT.jsonl [ARGS]
//   phases OUT N      Q1 boot phases, one fresh process per round
//   pin               copy the consumer's interpreter into build/bootimage/interp (once)
//   probe             build/bootimage/probe.wasm: the module with its two mutable globals exported
//   anatomy OUT       Q2 image anatomy; writes the images under build/bootimage/
//   bake NAME OUT     the module with the delta image (NAME boot or render) as data segments
//   bundle OUT DIR    the host's dry-run bundle size (wrangler deploy --dry-run in DIR), minus the plain module
//   deliver OUT N     Q3 a, b and c on the stored images; d on the baked modules (compile, instance)
//   retain OUT N      Q3 d memory retention, one process per variant and round
//   workerd OUT [N]   R3 modules in local workerd: instantiate, empty-memory modules, rss
//   render OUT        Q4 render a page from the baked module (plain and fd variants, no replay)
//   replay OUT N [SEED]  R1 baked modules with the full JS-side replay; N fresh processes
//   arms OUT N [SEED]    R2 plain, baked-boot and baked-render arms, N fresh processes each
//   seedgen OUT       node seeds A and B (rows of Drupal-created nodes) under build/bootimage/
//   reference OUT N [SEED]  booted renders of the front page and each seed node (the hashes)
// FOLIO_CONSUMER, FOLIO_MACHINE as in php-snapshot.ts

const PAGE = 65536;
const here = new URL('.', import.meta.url);
const repo = new URL('../../', import.meta.url).pathname;
const root = process.env.FOLIO_BOOTIMAGE_ROOT ?? repo;
const consumer = consumerRoot();
const work = join(root, 'build/bootimage');
const bundle = join(root, 'build/boot-image-child.mjs');
// the interpreter is copied once into build/bootimage/interp so a rebuild of the consumer's
// .interp cannot change a run in the middle (mode pin)
const pinned = join(work, 'interp');
const original = join(pinned, 'php8.5.tuned.wasm');
const glue = join(pinned, 'php8.5-worker.tuned.mjs');
const child = process.env.FOLIO_BOOTIMAGE_CHILD === '1';

type Row = Record<string, any>;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

const [mode, arg1, arg2, ...more] = process.argv.slice(2);
const output = mode === 'bake' ? arg2 : arg1;
const rest = (mode === 'bake' ? more : [arg2, ...more]).filter(
	(value): value is string => value !== undefined
);
const digestOf = (path: string) =>
	existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : undefined;
// the interpreter every row of this process ran on (the pinned private copy)
const interp = { wasmSha256: digestOf(original), glueSha256: digestOf(glue) };
function readMeta() {
	const meta = JSON.parse(readFileSync(join(work, 'meta.json'), 'utf8'));
	if (meta.interpSha256 !== interp.wasmSha256)
		throw new Error(
			`images were taken on ${meta.interpSha256}, the pin is ${interp.wasmSha256}`
		);
	return meta;
}
const emit = (row: Row) => {
	if (!output) return;
	appendFileSync(output, JSON.stringify({ ...row, interp, load: loadavg() }) + '\n');
};

function environment() {
	emit({
		kind: 'environment',
		machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
		node: process.version,
		cpu: cpus()[0]!.model,
		hardwareThreads: cpus().length,
		mode
	});
}

// #region orchestrator

async function buildChild() {
	mkdirSync(join(bundle, '..'), { recursive: true });
	const { build } = await import('esbuild');
	await build({
		entryPoints: [new URL('./boot-image.ts', here).pathname],
		outfile: bundle,
		bundle: true,
		platform: 'node',
		format: 'esm',
		logLevel: 'error',
		external: ['node:*', 'esbuild', 'binaryen'],
		plugins: [
			{
				name: 'consumer',
				setup(builder) {
					builder.onResolve({ filter: /^consumer:/ }, (args) => ({
						path: resolveConsumer(consumer, args.path)
					}));
					builder.onResolve({ filter: /^fflate-real$/ }, () =>
						builder.resolve('fflate', {
							resolveDir: consumer,
							kind: 'import-statement'
						})
					);
					builder.onResolve({ filter: /^fflate$/ }, (args) =>
						args.importer.endsWith('lazy-fs.ts')
							? { path: new URL('./timed-fflate.ts', here).pathname }
							: undefined
					);
				}
			}
		]
	});
}

function runChild(args: string[], execArgv: string[] = ['--expose-gc']) {
	const done = spawnSync(process.execPath, [...execArgv, bundle, ...args], {
		stdio: 'inherit',
		env: {
			...process.env,
			FOLIO_BOOTIMAGE_CHILD: '1',
			FOLIO_BOOTIMAGE_ROOT: root,
			FOLIO_CONSUMER: consumer
		}
	});
	if (done.status !== 0) throw new Error(`child ${args.join(' ')} exited ${done.status}`);
}

type Binaryen = typeof import('binaryen').default;

/** the module's mutable defined globals with their initial values and wasm global indexes */
async function loadModule(bytes: Uint8Array = readFileSync(original)) {
	const binaryen: Binaryen = (await import('binaryen')).default;
	const mod = binaryen.readBinary(bytes);
	const globals: { name: string; index: number; value: number }[] = [];
	for (let index = 0; index < mod.getNumGlobals(); index++) {
		const info = binaryen.getGlobalInfo(mod.getGlobalByIndex(index));
		if (!info.mutable || !info.init) continue;
		const init = binaryen.getExpressionInfo(info.init) as any;
		globals.push({ name: info.name, index, value: Number(init.value) });
	}
	return { binaryen, mod, globals };
}

/**
 * copies a PHP build once into build/bootimage/interp; FOLIO_PIN_SOURCE is a folder holding
 * php.wasm and glue.mjs (default experiments/consumer/build/php). FOLIO_PIN_WASM_SHA256 and
 * FOLIO_PIN_GLUE_SHA256, when set, must equal the copied files' digests or the pin refuses. A
 * second build gets its own images and results by setting FOLIO_BOOTIMAGE_ROOT to another folder.
 * REPIN=1 replaces an existing pin.
 */
function pinInterpreter() {
	mkdirSync(pinned, { recursive: true });
	const source = process.env.FOLIO_PIN_SOURCE ?? join(root, 'experiments/consumer/build/php');
	const expected = [process.env.FOLIO_PIN_WASM_SHA256, process.env.FOLIO_PIN_GLUE_SHA256];
	const rows = [
		['php.wasm', 'php8.5.tuned.wasm'],
		['glue.mjs', 'php8.5-worker.tuned.mjs']
	].map(([from, name]) => {
		const path = join(source, from!);
		const to = join(pinned, name!);
		const copied = process.env.REPIN === '1' || !existsSync(to);
		if (copied) writeFileSync(to, readFileSync(path));
		return { name, copied, bytes: readFileSync(to).length, sha256: digestOf(to) };
	});
	rows.forEach((row, i) => {
		if (expected[i] && row.sha256 !== expected[i])
			throw new Error(`pinned ${row.name} ${row.sha256} is not the expected ${expected[i]}`);
	});
	emit({
		kind: 'pin',
		source: basename(source),
		files: rows,
		consumerInterpNowSha256: digestOf(join(consumer, '.interp/php8.5.tuned.wasm'))
	});
}

/** the upload size of a host bundle with the plain module; what is not the module is what a baked module is added to */
function bundleSize(dir: string) {
	const run = spawnSync(
		'npx',
		['wrangler', 'deploy', '--dry-run', '-c', 'wrangler.deploy.jsonc', '--outdir', 'dry'],
		{
			cwd: dir,
			encoding: 'utf8',
			env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }
		}
	);
	const total = /Total Upload: ([\d.]+) KiB/.exec(`${run.stdout}${run.stderr}`);
	if (!total) throw new Error('no Total Upload line in the dry-run output');
	const moduleBytes = readFileSync(join(dir, '.interp/php8.5.tuned.wasm')).length;
	const totalUploadKiB = Number(total[1]);
	emit({
		kind: 'bundle',
		moduleBytes,
		moduleSha256: digestOf(join(dir, '.interp/php8.5.tuned.wasm')),
		totalUploadKiB,
		nonModuleKiB: Math.round((totalUploadKiB - moduleBytes / 1024) * 100) / 100
	});
}

async function buildProbe() {
	mkdirSync(work, { recursive: true });
	const { mod, globals } = await loadModule();
	globals.forEach((g, i) => mod.addGlobalExport(g.name, `bi_global${i}`));
	writeFileSync(join(work, 'probe.wasm'), mod.emitBinary());
	const plain = globals.map(({ name, value }) => ({ name, value }));
	writeFileSync(join(work, 'globals-initial.json'), JSON.stringify(plain));
	emit({ kind: 'probe', globals: plain });
}

/** the delta image as data segments over the original module; globals set to the booted values */
async function bake(name: string) {
	const meta = readMeta();
	const entry = meta.images[name];
	const pages: number[] = JSON.parse(
		readFileSync(join(work, `${name}.delta.pages.json`), 'utf8')
	);
	const data = new Uint8Array(readFileSync(join(work, `${name}.delta.bin`)));
	const bytes = new Uint8Array(readFileSync(original));
	const t0 = performance.now();
	const before = await loadModule(bytes);
	const readMs = performance.now() - t0;
	const segmentsBefore = (before.mod as any).getNumDataSegments();
	before.mod.dispose();
	const values: number[] = entry.globals;
	const changed: Record<number, number> = {};
	before.globals.forEach((g, i) => {
		if (values[i] !== g.value) changed[g.index] = values[i]!;
	});
	const image: MemoryImage = {
		byteLength: entry.memoryBytes,
		pages,
		data,
		module: interp.wasmSha256,
		...(Object.keys(changed).length ? { globals: changed } : {})
	};
	const t1 = performance.now();
	const out = await bakeModule(bytes, image);
	const bakeMs = performance.now() - t1;
	const t2 = performance.now();
	const check = checkBaked(out, image);
	const checkMs = performance.now() - t2;
	writeFileSync(join(work, `baked-${name}.wasm`), out);
	const after = await loadModule(out);
	const segmentsTotal = (after.mod as any).getNumDataSegments();
	after.mod.dispose();
	emit({
		kind: 'bake',
		name,
		readMs,
		bakeMs,
		checkMs,
		segmentsAdded: segmentsTotal - segmentsBefore,
		segmentsTotal,
		originalSha256: interp.wasmSha256,
		bakedSha256: createHash('sha256').update(out).digest('hex'),
		deltaBytes: data.length,
		moduleBytes: out.length,
		originalBytes: bytes.length,
		globalsSet: before.globals.map((g, i) => ({
			name: g.name,
			initial: g.value,
			booted: values[i]
		})),
		globalsReadBack: after.globals.map((g) => g.value),
		checkEqual: check.equal,
		valid: WebAssembly.validate(out as BufferSource)
	});
}

// #region workerd

const workerSource = `
import mod from './mod.wasm';
const imports = (pages) => {
	const out = {};
	for (const item of WebAssembly.Module.imports(mod)) {
		out[item.module] ??= {};
		out[item.module][item.name] =
			item.kind === 'memory'
				? new WebAssembly.Memory({ initial: pages, maximum: 65536 })
				: item.kind === 'global'
					? new WebAssembly.Global({ value: 'i32', mutable: true }, 0)
					: () => 0;
	}
	return out;
};
const held = [];
export default {
	async fetch(request) {
		const url = new URL(request.url);
		const pages = Number(url.searchParams.get('pages') ?? 0);
		const k = Number(url.searchParams.get('k') ?? 1);
		const inner = performance.now();
		let last;
		if (url.pathname === '/instantiate') {
			const hold = url.searchParams.has('hold');
			for (let i = 0; i < k; i++) {
				last = new WebAssembly.Instance(mod, imports(pages));
				if (hold) held.push(last);
			}
		} else if (url.pathname === '/memory') {
			for (let i = 0; i < k; i++) last = new WebAssembly.Memory({ initial: pages, maximum: 65536 });
		} else if (url.pathname === '/touch') {
			// writes one byte per 64 KiB page of every held memory, as a render's first pass would
			for (const instance of held) {
				const memory = Object.values(instance.exports).find((e) => e instanceof WebAssembly.Memory);
				if (memory) { const b = new Uint8Array(memory.buffer); for (let p = 0; p < b.length; p += 65536) b[p] = 1; }
			}
		} else if (url.pathname === '/drop') {
			held.length = 0;
		}
		return Response.json({ inner: performance.now() - inner, held: held.length });
	}
};
`;

const leb = (value: number) => {
	const out: number[] = [];
	do {
		let byte = value & 0x7f;
		value >>>= 7;
		if (value) byte |= 0x80;
		out.push(byte);
	} while (value);
	return out;
};

/** (module (memory PAGES)) with no data segments */
const emptyModule = (pages: number) => {
	const body = [1, 0, ...leb(pages)];
	return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, body.length, ...body]);
};

const freePort = () =>
	new Promise<number>((done, fail) => {
		const server = createServer();
		server.once('error', fail);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number };
			server.close(() => done(port));
		});
	});

const rssKb = (pid: number) =>
	Number(spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());

async function workerdBench(reps: number) {
	const meta = readMeta();
	const dir = join(work, 'workerd');
	mkdirSync(dir, { recursive: true });
	const bin = join(repo, 'node_modules/workerd/bin/workerd');
	writeFileSync(join(dir, 'worker.mjs'), workerSource);
	const variants: { name: string; bytes: Uint8Array; pages: number; kind: string }[] = [
		{ name: 'unmodified', bytes: readFileSync(original), pages: 1024, kind: 'interpreter' },
		{
			name: 'baked-boot',
			bytes: readFileSync(join(work, 'baked-boot.wasm')),
			pages: meta.images.boot.memoryBytes / PAGE,
			kind: 'interpreter'
		},
		{
			name: 'baked-render',
			bytes: readFileSync(join(work, 'baked-render.wasm')),
			pages: meta.images.render.memoryBytes / PAGE,
			kind: 'interpreter'
		},
		...[16, 64, 128].map((mib) => ({
			name: `empty-${mib}mib`,
			bytes: emptyModule((mib * 1024 * 1024) / PAGE),
			pages: (mib * 1024 * 1024) / PAGE,
			kind: 'empty'
		})),
		...[16, 64, 128].map((mib) => ({
			name: `empty-import-${mib}mib`,
			bytes: Buffer.alloc(0),
			pages: (mib * 1024 * 1024) / PAGE,
			kind: 'empty-import'
		}))
	];
	// (module (import "env" "memory" (memory PAGES)))
	for (const v of variants.filter((x) => x.kind === 'empty-import')) {
		const memType = [0, ...leb(v.pages)];
		const body = [1, 3, 0x65, 0x6e, 0x76, 6, ...Buffer.from('memory'), 2, ...memType];
		v.bytes = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 2, body.length, ...body]);
	}
	for (const v of variants) {
		writeFileSync(join(dir, `${v.name}.wasm`), v.bytes);
		emit({
			kind: 'wmodule',
			variant: v.name,
			moduleBytes: v.bytes.length,
			gzipBytes:
				v.kind === 'interpreter' ? gzipSync(v.bytes, { level: 9 }).length : undefined,
			pages: v.pages,
			valid: WebAssembly.validate(v.bytes as BufferSource)
		});
	}
	const ask = async (port: number, path: string) => {
		const t = performance.now();
		const response = await fetch(`http://127.0.0.1:${port}${path}`);
		const body: any = await response.json();
		return { ms: performance.now() - t, body, status: response.status };
	};
	for (const v of variants) {
		for (let rep = 0; rep < reps; rep++) {
			const port = await freePort();
			writeFileSync(
				join(dir, `${v.name}.capnp`),
				`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
	services = [(name = "main", worker = .w)],
	sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]
);
const w :Workerd.Worker = (
	modules = [
		(name = "worker.mjs", esModule = embed "worker.mjs"),
		(name = "mod.wasm", wasm = embed "${v.name}.wasm")
	],
	compatibilityDate = "2026-10-01"
);
`
			);
			const t0 = performance.now();
			const child = spawn(bin, ['serve', join(dir, `${v.name}.capnp`)], { stdio: 'ignore' });
			const pid = child.pid!;
			let up = false;
			let first!: Awaited<ReturnType<typeof ask>>;
			for (let attempt = 0; attempt < 400 && !up; attempt++) {
				try {
					first = await ask(port, '/noop');
					up = first.status === 200;
				} catch {
					await new Promise((done) => setTimeout(done, 25));
				}
			}
			const startMs = performance.now() - t0;
			if (!up) {
				emit({ kind: 'workerd', variant: v.name, rep, ok: false });
				child.kill();
				continue;
			}
			const settle = () => new Promise((done) => setTimeout(done, 150));
			await settle();
			const rssStart = rssKb(pid);
			const query = `pages=${v.pages}`;
			const op = v.kind === 'interpreter' || v.kind === 'empty' ? '/instantiate' : '/memory';
			const samples: Row[] = [];
			const noops: number[] = [];
			for (let i = 0; i < 6; i++) {
				const n = await ask(port, '/noop');
				noops.push(n.ms);
				const a = await ask(port, `${op}?${query}&k=1`);
				samples.push({ ms: a.ms, inner: a.body.inner });
			}
			// import-only modules have nothing to instantiate: /memory times the JS-side memory
			const importOnly = v.kind === 'empty-import';
			const rssAfterFirst = rssKb(pid);
			const many = await ask(port, `${op}?${query}&k=10`);
			await settle();
			const rssAfterMany = rssKb(pid);
			const heldAsk = importOnly
				? undefined
				: await ask(port, `/instantiate?${query}&k=3&hold=1`);
			await settle();
			const rssHeld = rssKb(pid);
			if (!importOnly) await ask(port, '/touch');
			await settle();
			const rssTouched = rssKb(pid);
			if (!importOnly) await ask(port, '/drop');
			await settle();
			const rssDropped = rssKb(pid);
			emit({
				kind: 'workerd',
				variant: v.name,
				operation: op,
				rep,
				ok: true,
				startMs,
				firstNoopMs: first.ms,
				noopMs: noops,
				firstMs: samples[0]!.ms,
				firstInnerMs: samples[0]!.inner,
				warmMs: samples.slice(1).map((s) => s.ms),
				manyMs: many.ms,
				manyCount: 10,
				heldMs: heldAsk?.ms,
				rssKb: {
					start: rssStart,
					afterFirst: rssAfterFirst,
					afterMany: rssAfterMany,
					held3: rssHeld,
					touched3: rssTouched,
					dropped: rssDropped
				}
			});
			child.kill();
			await new Promise((done) => child.once('exit', done));
		}
	}
}

// #endregion

if (!child) {
	if (!mode) throw new Error('usage: boot-image.ts MODE OUTPUT.jsonl [ARGS]');
	if (mode !== 'pin' && !existsSync(original)) throw new Error('run the pin mode first');
	environment();
	if (mode === 'workerd') await workerdBench(Number(rest[0] ?? 20));
	else if (mode === 'pin') pinInterpreter();
	else if (mode === 'bundle') bundleSize(arg2 ?? consumer);
	else if (mode === 'probe') await buildProbe();
	else if (mode === 'bake') await bake(arg1!);
	else {
		await buildChild();
		if (mode === 'phases') {
			for (let i = 0; i < Number(rest[0] ?? 10); i++)
				runChild(['phases', output!, String(i)]);
		} else if (mode === 'render') {
			for (const name of ['boot', 'render']) runChild(['render', output!, name, 'plain']);
			runChild(['render', output!, 'boot', 'fd']);
		} else if (mode === 'anatomy') {
			for (let i = 0; i < Number(rest[0] ?? 3); i++)
				runChild(['anatomy', output!, String(i)]);
		} else if (mode === 'retain') {
			for (let i = 0; i < Number(rest[0] ?? 5); i++)
				for (const variant of ['plain', 'baked'])
					runChild(['retain', output!, variant, String(i)]);
		} else if (mode === 'seedgen') {
			for (const name of ['A', 'B']) runChild(['seedgen', output!, name]);
		} else if (mode === 'reference') {
			for (let i = 0; i < Number(rest[0] ?? 3); i++)
				runChild(['reference', output!, String(i), rest[1] ?? '']);
		} else if (mode === 'arms') {
			for (let i = 0; i < Number(rest[0] ?? 10); i++)
				for (const name of ['plain', 'boot', 'render'])
					runChild(['arm', output!, name, String(i), rest[1] ?? '']);
		} else if (mode === 'replay') {
			for (let i = 0; i < Number(rest[0] ?? 10); i++)
				for (const name of ['boot', 'render'])
					runChild(['render', output!, name, 'replay', String(i), rest[1] ?? '']);
		} else runChild([mode, output!, ...rest]);
	}
	// the pinned copy is private, so a change here would mean something wrote to it mid-run
	const after = { wasmSha256: digestOf(original), glueSha256: digestOf(glue) };
	if (mode !== 'pin')
		emit({
			kind: 'interpCheck',
			start: interp,
			end: after,
			same: after.wasmSha256 === interp.wasmSha256 && after.glueSha256 === interp.glueSha256,
			consumerInterpNowSha256: digestOf(join(consumer, '.interp/php8.5.tuned.wasm'))
		});
	if (
		mode !== 'pin' &&
		(after.wasmSha256 !== interp.wasmSha256 || after.glueSha256 !== interp.glueSha256)
	)
		throw new Error('the pinned interpreter changed during the run');
	process.exit(0);
}

// #region child

const g = globalThis as any;
g.self ??= g;
g.location ??= new URL('https://folio.invalid/worker.mjs');

const consumerUrl = (path: string) => pathToFileURL(join(consumer, path)).href;
const now = () => performance.now();
const gc = () => (globalThis as any).gc?.();
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const view = (memory: WebAssembly.Memory) => new Uint8Array(memory.buffer);

/** the module's function imports as stubs; instantiation calls none of them (no start function) */
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

/** pages of `after` that differ from `before`; a shorter `before` counts as zero past its end */
const dirtied = (before: Uint8Array, after: Uint8Array) => captureImage(after, before).pages;

interface Context {
	php: any;
	binary: any;
	run(code: string): Promise<string>;
	render(path?: string): Promise<Row>;
	memory: WebAssembly.Memory;
	instance: WebAssembly.Instance;
	imports: WebAssembly.Imports;
	module: WebAssembly.Module;
	marks: Record<string, any>;
	drupal: any;
}

interface OpenOptions {
	/** the baked module: runtime init is skipped because the image already ran it */
	baked?: boolean;
	/** memory pages for the imported memory (default the harness size) */
	pages?: number;
	/** stop after the JS-side setup; no shims and no kernel boot */
	jsOnly?: boolean;
	/** collects every EM_ASM call the init exports make, with the arguments they read */
	traceAsm?: Row[];
	/** the JS-side state a baked heap refers to: the init exports' EM_ASM blocks, fds, handles */
	replay?: Replay;
	/** node rows (build/bootimage/seed-NAME.json) added to the private database before open */
	seed?: string;
}

interface Replay {
	/** the value of the imported __stack_pointer global when the image was taken */
	stackPointer?: number;
	/** the glue wraps Module.cfw* functions before PHP sees them (the hardened glue) */
	sealed?: boolean;
	asm: Row[];
	streams: any[];
	handles: any[];
}

let heapStoreModule: any;
const heapStore = async () => (heapStoreModule ??= await import('consumer:src/db/heap-store.ts'));

/**
 * reopens the descriptors and re-registers the handles at their ids, as the product does; the
 * handle table goes through the glue's own Module.__cfwSeal and Module.__cfwRoot
 */
function replayState(binary: any, replay: Replay) {
	const h = heapStoreModule;
	const streams = h.replayStreams(binary.FS, replay.streams);
	const handles = h.replayHandles(binary.targets, binary, replay.handles);
	return {
		streamsReplayed: streams.replayed.length,
		streamsFailed: streams.failed,
		handlesReplayed: handles.replayed.length,
		handlesFailed: handles.failed,
		handleNextId: handles.nextId
	};
}

/** wraps the EM_ASM entry points; reads the signature and arguments the way the glue does */
function traceAsm(
	given: WebAssembly.Imports,
	memory: WebAssembly.Memory,
	out: Row[],
	stage: () => string
) {
	const env = given.env as Record<string, (...args: number[]) => number>;
	for (const key of Object.keys(env).filter((name) => name.includes('asm_const'))) {
		const original = env[key]!;
		env[key] = (code, sigPtr, argbuf) => {
			if (stage()) {
				const bytes = new Uint8Array(memory.buffer);
				const f64 = new Float64Array(memory.buffer);
				const i32 = new Int32Array(memory.buffer);
				let sig = '';
				const args: number[] = [];
				let buf = argbuf >>> 0;
				for (let at = sigPtr >>> 0, ch; (ch = bytes[at++]);) {
					sig += String.fromCharCode(ch);
					const wide = ch !== 105 && ch !== 112;
					if (wide && buf % 8) buf += 4;
					args.push(ch === 112 || ch === 105 ? i32[buf >>> 2]! : f64[buf >>> 3]!);
					buf += wide ? 8 : 4;
				}
				out.push({ key, stage: stage(), code: code >>> 0, sig, args });
			}
			return original(code, sigPtr, argbuf);
		};
	}
}

/** the php-context-worker open path with a timestamp at each phase */
async function openContext(
	module: WebAssembly.Module,
	options: OpenOptions = {}
): Promise<Context> {
	const marks: Record<string, any> = {};
	await heapStore();
	const cpu0 = process.cpuUsage();
	const t0 = now();
	const drupal: any = await import('./php-context-drupal.ts');
	await drupal.prepare(consumer);
	marks.seedMs = now() - t0;
	if (options.seed) {
		const ts = now();
		marks.nodeSeedRows = applySeed(drupal.database(), options.seed);
		marks.nodeSeedMs = now() - ts;
	}
	const t1 = now();
	const { default: Factory } = await import(pathToFileURL(glue).href);
	const { PhpBase } = await import(consumerUrl('node_modules/php-wasm/PhpBase.mjs'));
	marks.importMs = now() - t1;
	let memory!: WebAssembly.Memory;
	let instance!: WebAssembly.Instance;
	let imports!: WebAssembly.Imports;
	let stage = '';
	const printed: string[] = [];
	const t2 = now();
	const php = new PhpBase(
		Promise.resolve({ default: Factory }) as any,
		{
			ini: [
				'opcache.enable=0',
				'opcache.enable_cli=0',
				'memory_limit=96M',
				drupal.disabled()
			].join('\n'),
			printErr: () => {},
			instantiateWasm(given: WebAssembly.Imports, receive: (a: any, b: any) => void) {
				(async () => {
					await Promise.resolve();
					const tm = now();
					memory = new WebAssembly.Memory(
						options.pages ? { initial: options.pages, maximum: 65536 } : drupal.memory()
					);
					(given.env as any).memory = memory;
					marks.memoryMs = now() - tm;
					imports = given;
					if (options.replay?.stackPointer !== undefined)
						(given.env as any).__stack_pointer.value = options.replay.stackPointer;
					if (options.traceAsm) traceAsm(given, memory, options.traceAsm, () => stage);
					const ti = now();
					instance = new WebAssembly.Instance(module, given);
					marks.instantiateMs = now() - ti;
					const exports: Record<string, any> = { ...instance.exports };
					for (const name of ['__wasm_call_ctors', 'pib_storage_init', 'pib_init']) {
						const original = instance.exports[name] as (...args: any[]) => any;
						exports[name] = (...args: any[]) => {
							if (options.baked) {
								const s = now();
								for (const call of options.replay?.asm ?? [])
									if (call.stage === name)
										(given.env as any)[call.key](call.code, 0, 0);
								marks[name + 'Ms'] = (marks[name + 'Ms'] ?? 0) + now() - s;
								return 0;
							}
							const s = now();
							stage = name;
							try {
								return original(...args);
							} finally {
								stage = '';
								marks[name + 'Ms'] = (marks[name + 'Ms'] ?? 0) + now() - s;
							}
						};
					}
					receive({ exports }, module);
				})().catch((error) => {
					console.error(error);
					process.exit(1);
				});
				return {};
			}
		} as any
	);
	php.addEventListener('output', (event: any) => printed.push(...[].concat(event.detail ?? [])));
	const binary = await php.binary;
	marks.factoryMs = now() - t2;
	const run = async (code: string) => {
		printed.length = 0;
		await php._run(code);
		return printed.join('');
	};
	const stamps: number[] = [];
	const timedRun = async (code: string) => {
		stamps.push(now());
		try {
			return await run(code);
		} finally {
			stamps.push(now());
		}
	};
	const tb = now();
	await drupal.boot(binary, timedRun, { jsOnly: options.jsOnly });
	marks.bootMs = now() - tb;
	if (options.replay) {
		const t = now();
		marks.replay = replayState(binary, options.replay);
		marks.replayMs = now() - t;
	}
	if (stamps.length) {
		marks.mountsMs = stamps[0]! - tb;
		marks.shimsMs = stamps[stamps.length - 2]! - stamps[0]!;
		marks.kernelMs = stamps[stamps.length - 1]! - stamps[stamps.length - 2]!;
	} else marks.mountsMs = marks.bootMs;
	const cpu = process.cpuUsage(cpu0);
	marks.openMs = now() - t0;
	marks.openCpuMs = (cpu.user + cpu.system) / 1000;
	const render = async (path?: string) => {
		drupal.resetSql();
		const c0 = process.cpuUsage();
		const s = now();
		const raw = await run(drupal.renderCode(path));
		const ms = now() - s;
		const c = process.cpuUsage(c0);
		return { ...drupal.summarize(raw), ms, cpuMs: (c.user + c.system) / 1000 };
	};
	return { php, binary, run, render, memory, instance, imports, module, marks, drupal };
}

const compileModule = (bytes: BufferSource) => {
	const t = now();
	const module = new WebAssembly.Module(bytes);
	return { module, ms: now() - t };
};

const loadMeta = readMeta;

async function phases(round: number) {
	const { module, ms: compileMs } = compileModule(readFileSync(original));
	// the second context in a process finds the module's functions compiled and the JS warm
	for (const position of ['first', 'second']) {
		const ctx = await openContext(module);
		const first = await ctx.render();
		const second = await ctx.render();
		const m = ctx.marks;
		emit({
			kind: 'phases',
			round,
			position,
			compileMs: position === 'first' ? compileMs : undefined,
			...m,
			runtimeInitMs:
				m.factoryMs! -
				m.instantiateMs! -
				m.memoryMs! -
				(m.pib_storage_initMs ?? 0) -
				(m.pib_initMs ?? 0),
			firstRenderMs: first.ms,
			firstRenderCpuMs: first.cpuMs,
			firstSha256: first.sha256,
			secondRenderMs: second.ms,
			secondRenderCpuMs: second.cpuMs,
			secondSha256: second.sha256,
			memoryBytes: view(ctx.memory).length,
			rssBytes: process.memoryUsage().rss
		});
		ctx.drupal.close();
	}
}

const readGlobals = (instance: WebAssembly.Instance) =>
	Object.keys(instance.exports)
		.filter((name) => name.startsWith('bi_global'))
		.sort()
		.map((name) => Number((instance.exports[name] as WebAssembly.Global).value));

/** function index names per slot; a JS-added slot has a wrapper name of its own */
function tableNames(instance: WebAssembly.Instance) {
	const table = instance.exports.__indirect_function_table as WebAssembly.Table;
	return Array.from({ length: table.length }, (_, i) => table.get(i)?.name ?? null);
}

/** open descriptors in the Emscripten FS; the image holds their numbers, not their streams */
const openFds = (binary: any) =>
	(binary.FS.streams as any[])
		.map((stream, fd) =>
			stream ? { fd, path: stream.path ?? null, flags: stream.flags } : null
		)
		.filter(Boolean);

async function packStats(bytes: Uint8Array) {
	const h: any = await import('consumer:src/db/heap-store.ts');
	const fflate: any = await import('fflate-real');
	let t = now();
	const whole = fflate.deflateSync(bytes);
	const wholeMs = now() - t;
	t = now();
	let stored = 0;
	let rows = 0;
	let storedRaw = 0;
	for (const chunk of h.chunkHeap(bytes)) {
		const packed = h.packChunk(chunk.bytes);
		stored += packed.stored.length;
		rows++;
		if (packed.rawBytes === 0) storedRaw++;
	}
	return {
		rawBytes: bytes.length,
		wholeDeflateBytes: whole.length,
		wholeDeflateMs: wholeMs,
		chunkRows: rows,
		chunkStoredBytes: stored,
		chunkStoredRaw: storedRaw,
		chunkDeflateMs: now() - t
	};
}

async function anatomy(round: number) {
	mkdirSync(work, { recursive: true });
	const module = new WebAssembly.Module(readFileSync(join(work, 'probe.wasm')));
	const pibAsm: Row[] = [];
	const ctx = await openContext(module, { traceAsm: pibAsm });
	const heapStore: any = await import('consumer:src/db/heap-store.ts');
	const jsState = () => ({
		stackPointer: (ctx.imports.env as any).__stack_pointer
			? Number((ctx.imports.env as any).__stack_pointer.value)
			: undefined,
		sealed: typeof ctx.binary.__cfwSeal === 'function',
		streams: heapStore.captureStreams(ctx.binary.FS),
		...heapStore.captureHandles(ctx.binary.targets, ctx.binary)
	});
	const bootState = jsState();
	const dbBefore = tableDigests(ctx.drupal.database());
	const bootMemory = view(ctx.memory).slice();
	const bootGlobals = readGlobals(ctx.instance);
	const fdsAfterBoot = openFds(ctx.binary);
	const handlesAfterBoot = ctx.binary.targets?.byInteger?.size ?? null;
	const bootTable = tableNames(ctx.instance);
	const freshMemory = new WebAssembly.Memory({ initial: 1024, maximum: 65536 });
	const freshInstance = new WebAssembly.Instance(module, stubImports(module, freshMemory));
	const fresh = view(freshMemory);
	const freshTable = tableNames(freshInstance);
	const freshGlobals = readGlobals(freshInstance);
	const first = await ctx.render();
	const renderState = jsState();
	{
		const db = ctx.drupal.database();
		const changed = changedTables(dbBefore, tableDigests(db));
		const body = dumpTables(
			db,
			changed.map((c) => c.table)
		);
		writeFileSync(join(work, 'seed-R.json'), JSON.stringify(body));
		emit({
			kind: 'dbstate',
			round,
			changed,
			rowsWritten: changed.reduce((n, c) => n + Math.max(0, c.rowsAfter - c.rowsBefore), 0),
			seedBytes: JSON.stringify(body).length,
			cacheKeys: Object.fromEntries(
				changed
					.filter((c) => c.table.startsWith('cache_'))
					.map((c) => [
						c.table,
						db
							.prepare(`SELECT cid FROM "${c.table}" ORDER BY cid LIMIT 40`)
							.all()
							.map((row: any) => row.cid)
					])
			)
		});
	}
	const renderMemory = view(ctx.memory).slice();
	const renderGlobals = readGlobals(ctx.instance);
	const fdsAfterRender = openFds(ctx.binary);
	const handlesAfterRender = ctx.binary.targets?.byInteger?.size ?? null;
	const renderTable = tableNames(ctx.instance);
	const second = await ctx.render();
	const secondMemory = view(ctx.memory).slice();
	const images: Record<string, any> = {};
	const meta = {
		interpSha256: interp.wasmSha256,
		images,
		pibAsm,
		freshBytes: fresh.length,
		freshGlobals,
		freshTableLength: freshTable.length,
		firstSha256: first.sha256,
		secondSha256: second.sha256
	};
	const h: any = await import('consumer:src/db/heap-store.ts');
	for (const [name, memory, globals, table] of [
		['boot', bootMemory, bootGlobals, bootTable],
		['render', renderMemory, renderGlobals, renderTable]
	] as const) {
		const none = new Uint8Array(0);
		const nonzero = captureImage(memory, none);
		const deltaImage = captureImage(memory, fresh);
		const c = {
			nonzero: nonzero.pages,
			delta: deltaImage.pages,
			freshNonzero: captureImage(fresh, none).pages,
			zeroedByBoot: deltaImage.pages.filter((page) => !nonzero.pages.includes(page))
		};
		const nz = nonzero.data;
		const delta = deltaImage.data;
		for (const [kind, bytes, pages] of [
			['nz', nz, c.nonzero],
			['delta', delta, c.delta]
		] as const) {
			writeFileSync(join(work, `${name}.${kind}.bin`), bytes);
			writeFileSync(join(work, `${name}.${kind}.pages.json`), JSON.stringify(pages));
		}
		const sameInitial = freshTable.every((entry, i) => table[i] === entry);
		images[name] = {
			...(name === 'boot' ? bootState : renderState),
			memoryBytes: memory.length,
			globals,
			tableLength: table.length,
			tableChangedInInitialRange: freshTable.filter((entry, i) => table[i] !== entry).length,
			tableExtra: table.slice(freshTable.length).length,
			tableExtraNames: table.slice(freshTable.length, freshTable.length + 8),
			tableUnchanged: sameInitial
		};
		const writerParity = await (async () => {
			if (name !== 'boot') return undefined;
			const { DatabaseSync } = await import('node:sqlite');
			const db = new DatabaseSync(':memory:');
			const sql = sqlShim(db);
			h.ensureHeapTables(sql);
			const written = h.writeHeapSnapshot(sql, {
				heap: memory,
				streams: [],
				generation: 'g',
				nowMs: 0
			});
			db.close();
			return {
				rows: written.rows,
				compressedBytes: written.compressedBytes,
				keptPages: written.keptPages
			};
		})();
		emit({
			kind: 'anatomy',
			round,
			image: name,
			memoryBytes: memory.length,
			pages: memory.length / PAGE,
			nonzeroPages: c.nonzero.length,
			nonzeroBytes: c.nonzero.length * PAGE,
			freshNonzeroPages: c.freshNonzero.length,
			deltaPages: c.delta.length,
			deltaBytes: c.delta.length * PAGE,
			deltaZeroedByBootPages: c.zeroedByBoot.length,
			globals,
			freshGlobals,
			table: images[name],
			writerParity,
			nonzero: await packStats(nz),
			delta: await packStats(delta)
		});
	}
	const dirty = dirtied(bootMemory, renderMemory);
	const dirty2 = dirtied(renderMemory, secondMemory);
	emit({
		kind: 'dirty',
		round,
		bootToFirstRenderPages: dirty.length,
		bootToFirstRenderBytes: dirty.length * PAGE,
		firstToSecondRenderPages: dirty2.length,
		firstToSecondRenderBytes: dirty2.length * PAGE,
		memoryGrewBytes: renderMemory.length - bootMemory.length,
		firstSha256: first.sha256,
		secondSha256: second.sha256,
		openMs: ctx.marks.openMs,
		fdsAfterBoot,
		fdsAfterRender,
		handlesAfterBoot,
		handlesAfterRender,
		classesAfterRender: ctx.binary._classes?.size ?? null
	});
	emit({
		kind: 'php',
		version: (await ctx.run('<?php echo PHP_VERSION;')).trim(),
		wasmSha256: interp.wasmSha256
	});
	writeFileSync(join(work, 'meta.json'), JSON.stringify(meta));
	ctx.drupal.close();
}

/** the HeapSql surface over node:sqlite; reads stay lazy so a restore walks one row at a time */
function sqlShim(db: any) {
	return {
		exec(query: string, ...bindings: any[]) {
			const statement = db.prepare(query);
			if (!/^\s*select/i.test(query)) {
				const rows = statement.all(...bindings);
				return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
			}
			return {
				toArray: () => statement.all(...bindings),
				[Symbol.iterator]: () => statement.iterate(...bindings)
			};
		}
	};
}

interface Image {
	bytes: Uint8Array;
	pages: number[];
}

const loadImage = (name: string, kind: string): Image => ({
	bytes: readFileSync(join(work, `${name}.${kind}.bin`)),
	pages: JSON.parse(readFileSync(join(work, `${name}.${kind}.pages.json`), 'utf8'))
});

function expand(image: Image, byteLength: number) {
	const full = new Uint8Array(byteLength);
	image.pages.forEach((p, i) =>
		full.set(image.bytes.subarray(i * PAGE, (i + 1) * PAGE), p * PAGE)
	);
	return full;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
	Buffer.from(a.buffer, a.byteOffset, a.length).equals(
		Buffer.from(b.buffer, b.byteOffset, b.length)
	);

/** the product's two tables in node:sqlite, filled by the product's own chunk and pack helpers */
async function storeImage(image: Image, byteLength: number, chunkBytes: number, pack: boolean) {
	const h: any = await import('consumer:src/db/heap-store.ts');
	const { DatabaseSync } = await import('node:sqlite');
	const sql = sqlShim(new DatabaseSync(':memory:'));
	h.ensureHeapTables(sql);
	const id = Number(
		sql
			.exec(
				`INSERT INTO cfw_heap_snapshot (created_at, byte_length, page_bytes, total_pages, kept_pages,
				page_index, chunk_bytes, digest, generation, fd_table, handle_table)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
				0,
				byteLength,
				PAGE,
				byteLength / PAGE,
				image.pages.length,
				JSON.stringify(image.pages),
				chunkBytes,
				'x',
				'g',
				'[]',
				'[]'
			)
			.toArray()[0]!.id
	);
	let storedBytes = 0;
	let rows = 0;
	for (const chunk of h.chunkHeap(image.bytes, chunkBytes)) {
		const packed = pack ? h.packChunk(chunk.bytes) : { stored: chunk.bytes, rawBytes: 0 };
		sql.exec(
			'INSERT INTO cfw_heap_chunk (snapshot_id, seq, bytes, digest, raw_bytes) VALUES (?, ?, ?, ?, ?)',
			id,
			chunk.seq,
			packed.stored,
			h.digestBytes(chunk.bytes),
			packed.rawBytes
		);
		storedBytes += packed.stored.length;
		rows++;
	}
	return {
		h,
		sql,
		id,
		rows,
		storedBytes,
		meta: h.latestSnapshotMeta(sql),
		pageIndex: h.snapshotPageIndex(sql, id).pageIndex as number[]
	};
}

/** contiguous page runs copied with one set each */
function copyRuns(image: Image, target: Uint8Array) {
	let calls = 0;
	for (let i = 0; i < image.pages.length;) {
		let j = i;
		while (j + 1 < image.pages.length && image.pages[j + 1] === image.pages[j]! + 1) j++;
		target.set(image.bytes.subarray(i * PAGE, (j + 1) * PAGE), image.pages[i]! * PAGE);
		calls++;
		i = j + 1;
	}
	return calls;
}

async function deliver(reps: number) {
	const meta = loadMeta();
	const baseModule = new WebAssembly.Module(readFileSync(original));
	for (const name of ['boot', 'render']) {
		const byteLength: number = meta.images[name].memoryBytes;
		const pages = byteLength / PAGE;
		const full = expand(loadImage(name, 'nz'), byteLength);
		for (const shape of ['nz', 'delta']) {
			const image = loadImage(name, shape);
			const common = {
				image: name,
				shape,
				memoryBytes: byteLength,
				imageBytes: image.bytes.length
			};
			const instantiateBase = (memory: WebAssembly.Memory) => {
				if (shape !== 'delta') return 0;
				const t = now();
				new WebAssembly.Instance(baseModule, stubImports(baseModule, memory));
				return now() - t;
			};
			for (const [variant, chunkBytes, pack] of [
				['sql-deflated-200k', 200_000, true],
				['sql-raw-2m', 2_000_000, false]
			] as const) {
				const store = await storeImage(image, byteLength, chunkBytes, pack);
				const rows = store.sql
					.exec('SELECT bytes, raw_bytes FROM cfw_heap_chunk ORDER BY seq')
					.toArray();
				for (let rep = 0; rep < reps; rep++) {
					gc();
					const memory = new WebAssembly.Memory({ initial: pages, maximum: 65536 });
					const baseMs = instantiateBase(memory);
					const target = view(memory);
					const t = now();
					const result = store.h.streamRestoreInto(store.sql, target, {
						meta: store.meta,
						pageIndex: store.pageIndex
					});
					const ms = now() - t;
					const verified =
						rep === 0 || rep === reps - 1 ? sameBytes(target, full) : undefined;
					emit({
						kind: 'deliver',
						...common,
						variant,
						rep,
						ms,
						baseMs,
						rows: store.rows,
						storedBytes: store.storedBytes,
						chunks: result.chunks,
						complete: result.complete,
						verified
					});
					// the pieces on their own: row reads, inflate, digest
					const c0 = now();
					let held = 0;
					const stored: Uint8Array[] = [];
					for (const row of store.sql.exec(
						'SELECT bytes, raw_bytes FROM cfw_heap_chunk ORDER BY seq'
					) as Iterable<any>) {
						const copy = store.h.toStorableBytes(row.bytes);
						held += copy.length;
						stored.push(copy);
					}
					const readMs = now() - c0;
					const i0 = now();
					const inflated = stored.map((bytes, i) =>
						store.h.unpackChunk(bytes, Number(rows[i]!.raw_bytes))
					);
					const inflateMs = now() - i0;
					const d0 = now();
					for (const bytes of inflated) store.h.digestBytes(bytes);
					const digestMs = now() - d0;
					const f0 = now();
					store.h.digestBytes(full);
					emit({
						kind: 'component',
						...common,
						variant,
						rep,
						readMs,
						inflateMs,
						digestMs,
						heapDigestMs: now() - f0,
						storedBytes: held
					});
				}
			}
			for (let rep = 0; rep < reps; rep++) {
				gc();
				const memory = new WebAssembly.Memory({ initial: pages, maximum: 65536 });
				const baseMs = instantiateBase(memory);
				const target = view(memory);
				const t = now();
				const calls = copyRuns(image, target);
				const ms = now() - t;
				emit({
					kind: 'deliver',
					...common,
					variant: 'memory-copy',
					rep,
					ms,
					baseMs,
					calls,
					verified: rep === 0 ? sameBytes(target, full) : undefined
				});
			}
		}
	}
}

/** appends a one-byte-different custom section so V8's module cache cannot answer the compile */
function distinct(bytes: Uint8Array, rep: number) {
	const body = [1, 0x72, rep & 255, rep >> 8];
	return Buffer.concat([bytes, Buffer.from([0, body.length, ...body])]);
}

async function bakedBench(reps: number) {
	const meta = loadMeta();
	const variants: [string, string, string | undefined][] = [
		['unmodified', original, undefined],
		['baked-boot', join(work, 'baked-boot.wasm'), 'boot'],
		['baked-render', join(work, 'baked-render.wasm'), 'render']
	];
	for (const [variant, path, name] of variants) {
		if (!existsSync(path)) continue;
		const bytes = readFileSync(path);
		const byteLength: number = name ? meta.images[name].memoryBytes : 1024 * PAGE;
		const expected = name ? expand(loadImage(name, 'nz'), byteLength) : undefined;
		emit({ kind: 'module', variant, moduleBytes: bytes.length, memoryBytes: byteLength });
		for (let rep = 0; rep < reps; rep++) {
			const copy = distinct(bytes, rep);
			gc();
			const t = now();
			await WebAssembly.compile(copy);
			emit({ kind: 'compile', variant, rep, ms: now() - t });
		}
		const module = await WebAssembly.compile(bytes);
		for (let rep = 0; rep < reps; rep++) {
			gc();
			const m0 = now();
			const memory = new WebAssembly.Memory({ initial: byteLength / PAGE, maximum: 65536 });
			const memoryMs = now() - m0;
			const imports = stubImports(module, memory);
			const t = now();
			new WebAssembly.Instance(module, imports);
			const ms = now() - t;
			emit({
				kind: 'instance',
				variant,
				rep,
				ms,
				memoryMs,
				verified: expected && rep % 10 === 0 ? sameBytes(view(memory), expected) : undefined
			});
		}
	}
}

async function retain(variant: string, round: number) {
	const path = variant === 'plain' ? original : join(work, 'baked-boot.wasm');
	const sample = () => {
		const m = process.memoryUsage();
		return {
			rss: m.rss,
			external: m.external,
			arrayBuffers: m.arrayBuffers,
			heapUsed: m.heapUsed
		};
	};
	const settle = async () => {
		await new Promise((done) => setTimeout(done, 50));
		gc();
		gc();
	};
	await settle();
	const afterStart = sample();
	let module: WebAssembly.Module | null = await WebAssembly.compile(readFileSync(path));
	await settle();
	const afterCompile = sample();
	let memory: WebAssembly.Memory | null = new WebAssembly.Memory({
		initial: 1024,
		maximum: 65536
	});
	let instance: WebAssembly.Instance | null = new WebAssembly.Instance(
		module,
		stubImports(module, memory)
	);
	await settle();
	const afterInstance = sample();
	instance = null;
	memory = null;
	await settle();
	const afterInstanceDropped = sample();
	module = null;
	await settle();
	emit({
		kind: 'retain',
		variant,
		round,
		afterStart,
		afterCompile,
		afterInstance,
		afterInstanceDropped,
		afterModuleDropped: sample(),
		gcAvailable: typeof (globalThis as any).gc === 'function'
	});
}

const nodePage = (id: number) => `/node/${id}`;

/** row digest per table, so a render's writes show as the tables whose content changed */
function tableDigests(db: any) {
	const out: Record<string, { rows: number; digest: string }> = {};
	const names: string[] = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all()
		.map((row: any) => row.name);
	for (const name of names) {
		const lines: string[] = db
			.prepare(`SELECT * FROM "${name}"`)
			.all()
			.map((row: any) => JSON.stringify(Object.values(row).map(encodeCell)));
		const hash = createHash('sha256');
		for (const line of lines.sort()) hash.update(line);
		out[name] = { rows: lines.length, digest: hash.digest('hex') };
	}
	return out;
}

/** every table whose content differs between two digest maps, with its before and after row counts */
function changedTables(
	before: ReturnType<typeof tableDigests>,
	after: ReturnType<typeof tableDigests>
) {
	return Object.keys(after)
		.filter((name) => after[name]!.digest !== before[name]?.digest)
		.map((name) => ({
			table: name,
			rowsBefore: before[name]?.rows ?? 0,
			rowsAfter: after[name]!.rows
		}));
}

/** full contents of the named tables as a seed file body */
function dumpTables(db: any, names: string[]): SeedTable[] {
	return names.flatMap((table) => {
		const rows: any[] = db.prepare(`SELECT * FROM "${table}"`).all();
		if (!rows.length) return [];
		const columns = Object.keys(rows[0]);
		return [{ table, columns, rows: rows.map((r) => columns.map((c) => encodeCell(r[c]))) }];
	});
}

type SeedTable = { table: string; columns: string[]; rows: unknown[][] };
const encodeCell = (value: unknown) =>
	value instanceof Uint8Array ? { b64: Buffer.from(value).toString('base64') } : value;
const decodeCell = (value: any) =>
	value && typeof value === 'object' && 'b64' in value
		? new Uint8Array(Buffer.from(value.b64, 'base64'))
		: value;

/** the node tables' rows from the private database, as plain JSON */
function dumpNodeTables(db: any): SeedTable[] {
	const names: string[] = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'node%' ORDER BY name"
		)
		.all()
		.map((row: any) => row.name);
	const out: SeedTable[] = [];
	for (const table of names) {
		const rows: any[] = db.prepare(`SELECT * FROM "${table}"`).all();
		if (!rows.length) continue;
		const columns = Object.keys(rows[0]);
		out.push({ table, columns, rows: rows.map((r) => columns.map((c) => encodeCell(r[c]))) });
	}
	return out;
}

/** inserts a stored node seed; returns the row count */
function applySeed(db: any, name: string) {
	const tables: SeedTable[] = JSON.parse(readFileSync(join(work, `seed-${name}.json`), 'utf8'));
	let count = 0;
	for (const { table, columns, rows } of tables) {
		const insert = db.prepare(
			`INSERT OR REPLACE INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
		);
		for (const row of rows) {
			insert.run(...row.map(decodeCell));
			count++;
		}
	}
	return count;
}

const NODE_SEEDS: Record<string, { promote: number; titles: string[] }> = {
	A: {
		promote: 0,
		titles: ['Folio seed node one', 'Folio seed node two', 'Folio seed node three']
	},
	B: { promote: 1, titles: ['Different node alpha', 'Different node beta'] }
};

/** boots a plain context, creates a node set through Drupal itself and stores the node rows */
async function seedgen(name: string) {
	const set = NODE_SEEDS[name]!;
	const module = new WebAssembly.Module(readFileSync(original));
	const ctx = await openContext(module);
	const before = dumpNodeTables(ctx.drupal.database()).length;
	const php = `<?php
foreach (['SAVED_NEW' => 1, 'SAVED_UPDATED' => 2, 'SAVED_DELETED' => 3] as $k => $v) defined($k) || define($k, $v);
$storage = \\Drupal::entityTypeManager()->getStorage('node');
foreach (${JSON.stringify(set.titles)} as $i => $title) {
	$node = $storage->create(['type' => 'page', 'title' => $title, 'status' => 1,
		'promote' => ${set.promote}, 'sticky' => 0, 'uid' => 1, 'created' => 1700000000 + $i * 86400,
		'changed' => 1700000000 + $i * 86400,
		'body' => ['value' => '<p>' . $title . ' body text for the boot image seed.</p>', 'format' => 'basic_html']]);
	$node->save();
}
echo json_encode(['ok' => true, 'count' => count($storage->loadMultiple())]);`;
	const printed = await ctx.run(php);
	const tables = dumpNodeTables(ctx.drupal.database());
	writeFileSync(join(work, `seed-${name}.json`), JSON.stringify(tables));
	emit({
		kind: 'seedgen',
		name,
		titles: set.titles,
		promote: set.promote,
		printed: printed.slice(0, 400),
		tablesBefore: before,
		tables: tables.map((t) => [t.table, t.rows.length]),
		bytes: JSON.stringify(tables).length
	});
	ctx.drupal.close();
}

/** published nodes in the private seed database, lowest id first */
const publishedNodes = (drupal: any): number[] =>
	drupal
		.database()
		.prepare('SELECT DISTINCT nid FROM node_field_data WHERE status = 1 ORDER BY nid')
		.all()
		.map((row: any) => Number(row.nid));

/** booted context renders: the reference hashes a baked render is compared with */
async function reference(round: number, seed?: string) {
	const module = new WebAssembly.Module(readFileSync(original));
	const ctx = await openContext(module, { seed });
	const nodes = publishedNodes(ctx.drupal);
	const kv = () =>
		ctx.drupal
			.database()
			.prepare('SELECT collection, name FROM key_value')
			.all()
			.map((row: any) => `${row.collection}/${row.name}`);
	const kvBefore = new Set(kv());
	const front = await ctx.render('/');
	const kvAdded = kv().filter((name: string) => !kvBefore.has(name));
	const pages: Row[] = [];
	for (const nid of nodes) {
		const first = await ctx.render(nodePage(nid));
		pages.push({ path: nodePage(nid), sha256: first.sha256, bytes: first.bytes });
	}
	const frontAgain = await ctx.render('/');
	emit({
		kind: 'reference',
		round,
		seed,
		nodes,
		frontSha256: front.sha256,
		frontAgainSha256: frontAgain.sha256,
		frontBytes: front.bytes,
		kvAdded,
		pages,
		openMs: ctx.marks.openMs
	});
	ctx.drupal.close();
}

const replayOf = (image: any, meta: any): Replay => ({
	asm: meta.pibAsm.filter((call: Row) => call.sig === ''),
	stackPointer: image.stackPointer,
	sealed: image.sealed,
	streams: image.streams,
	handles: image.handles
});

/**
 * Q4/R1: the baked module under the harness's own JS-side setup, then renders, in a first and a
 * second context of one process. variant plain runs no replay, fd reopens only the descriptor,
 * replay runs the init blocks, stack pointer, fds and handles. A seed adds node rows (seed-NAME).
 */
async function renderBaked(name: string, variant: string, round = 0, seed?: string) {
	const meta = loadMeta();
	const image = meta.images[name];
	const replay = variant === 'replay';
	let stage = 'compile';
	try {
		const module = new WebAssembly.Module(readFileSync(join(work, `baked-${name}.wasm`)));
		const full = expand(loadImage(name, 'nz'), image.memoryBytes);
		for (const position of ['first', 'second']) {
			stage = `open ${position}`;
			const ctx = await openContext(module, {
				baked: true,
				pages: image.memoryBytes / PAGE,
				jsOnly: true,
				seed,
				replay: replay ? replayOf(image, meta) : undefined
			});
			stage = 'compare';
			const changed = dirtied(full, view(ctx.memory));
			const replayedFd =
				variant === 'fd' ? ctx.binary.FS.open('/dev/urandom', 'r').fd : undefined;
			const nodes = publishedNodes(ctx.drupal);
			const pages = ['/', ...(replay ? nodes.map(nodePage) : [])];
			for (const path of pages) {
				stage = `render ${path} ${position}`;
				const result = await ctx.render(path);
				emit({
					kind: 'render',
					image: name,
					variant,
					replay,
					round,
					position,
					seed,
					path,
					replayedFd,
					ok: true,
					sha256: result.sha256,
					ms: result.ms,
					pagesChangedBeforeRender: changed.length,
					marks: ctx.marks
				});
			}
			ctx.drupal.close();
		}
	} catch (error) {
		emit({
			kind: 'render',
			image: name,
			variant,
			replay,
			round,
			seed,
			ok: false,
			stage,
			error: String((error as Error)?.stack ?? error)
				.replace(/file:\/\/\/[^\s)]*\//g, '')
				.slice(0, 2500)
		});
	}
}

/**
 * R2: one arm in one fresh process, first and second context. plain boots the original module;
 * boot and render open the baked module and replay the JS-side state. Timed from the start of the
 * context open to the end of the first render.
 */
async function arm(name: string, round: number, seed?: string) {
	const meta = loadMeta();
	const baked = name !== 'plain';
	const image = baked ? meta.images[name] : undefined;
	const bytes = readFileSync(baked ? join(work, `baked-${name}.wasm`) : original);
	const tc = now();
	const module = new WebAssembly.Module(bytes);
	const compileMs = now() - tc;
	for (const position of ['first', 'second']) {
		const ctx = await openContext(
			module,
			baked
				? {
						baked: true,
						pages: image.memoryBytes / PAGE,
						jsOnly: true,
						seed,
						replay: replayOf(image, meta)
					}
				: { seed }
		);
		const first = await ctx.render('/');
		const second = await ctx.render('/');
		emit({
			kind: 'arm',
			arm: name,
			round,
			position,
			seed,
			compileMs: position === 'first' ? compileMs : undefined,
			...ctx.marks,
			replay: undefined,
			replayCounts: ctx.marks.replay,
			firstRenderMs: first.ms,
			firstRenderCpuMs: first.cpuMs,
			firstSha256: first.sha256,
			secondRenderMs: second.ms,
			secondSha256: second.sha256,
			totalMs: ctx.marks.openMs + first.ms,
			memoryBytes: view(ctx.memory).length,
			rssBytes: process.memoryUsage().rss
		});
		ctx.drupal.close();
	}
}

// #endregion

if (mode === 'phases') await phases(Number(rest[0]));
else if (mode === 'deliver') {
	await deliver(Number(rest[0] ?? 12));
	await bakedBench(Number(rest[1] ?? 30));
} else if (mode === 'retain') await retain(rest[0]!, Number(rest[1]));
else if (mode === 'render')
	await renderBaked(rest[0]!, rest[1] ?? 'plain', Number(rest[2] ?? 0), rest[3] || undefined);
else if (mode === 'reference') await reference(Number(rest[0] ?? 0), rest[1]);
else if (mode === 'seedgen') await seedgen(rest[0]!);
else if (mode === 'arm') await arm(rest[0]!, Number(rest[1] ?? 0), rest[2] || undefined);
else if (mode === 'anatomy') await anatomy(Number(rest[0] ?? 0));
else throw new Error(`unknown mode ${mode}`);
