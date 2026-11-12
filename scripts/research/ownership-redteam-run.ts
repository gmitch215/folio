import { spawn, spawnSync } from 'node:child_process';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
import { sameError } from './iteration-diff.ts';
import {
	ARENA_BYTES,
	ARENAS,
	DATA,
	OUT,
	RECORDS,
	SLICE,
	STACK_TOP,
	TABLE
} from './ownership-alloc-modules.ts';
import { assemble } from './ownership-modules.ts';
import { build, DEFAULT_WEIGHTS, plan, wat, type Plan } from './ownership-redteam.ts';
import {
	bootedImage,
	closeSliceRig,
	openSliceRig,
	serialRun,
	slicesRun,
	type SliceCall
} from './ownership-slices-rig.ts';

// usage: ownership-redteam-run.ts run START COUNT OUT.jsonl [ATTACK_WEIGHT]
//        ownership-redteam-run.ts one SEED            certify one plan and print the verdicts
//        ownership-redteam-run.ts minimize SEED DIR   drop statements while the module still lies
//        ownership-redteam-run.ts summary OUT.jsonl

const SEEDS = [1, 2, 3, 4, 5, 6];
const MAXPAGES = 40;
const EXTREME = [0, 1, 15, 512, 40000];
const worker = new URL('./ownership-ground-worker.ts', import.meta.url).pathname;
const LENGTHS = [0, 1, 2, 5, 15, 16, 17, 40, 63, 64];

const prng = (seed: number) => {
	let s = seed | 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return s & 255;
	};
};

// the standard layout with record lengths from zero up, and an aux input after each record's data
export function layout(view: Uint8Array, words: Uint32Array, seed: number) {
	const next = prng(seed);
	for (let i = 0; i < RECORDS; i++) {
		const at = DATA + i * 320;
		const length = LENGTHS[next() % LENGTHS.length]!;
		for (let k = 0; k < 320; k++) view[at + k] = k < length || k >= 128 ? next() % 254 : 0;
		if (seed % 3 === 0 && i === 3) view[at] = 255;
		words[(TABLE + 16 * i) / 4] = at;
		words[(TABLE + 16 * i + 4) / 4] = length;
		words[(TABLE + 16 * i + 8) / 4] = at + 128;
		for (let k = 0; k < SLICE; k++) view[ARENAS + i * SLICE + k] = 0xa5;
		for (let k = 0; k < ARENA_BYTES; k++)
			view[ARENAS + i * SLICE + k] = (i * 13 + k * 7 + seed) & 255;
		words[(TABLE + 16 * i + 12) / 4] = ARENAS + i * SLICE;
	}
	for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
}

export const image = (seed: number) => {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	layout(new Uint8Array(memory.buffer), new Uint32Array(memory.buffer), seed);
	return new Uint8Array(memory.buffer).slice();
};

const instantiate = (module: WebAssembly.Module, img: Uint8Array) => {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
	new Uint8Array(memory.buffer).set(img);
	const instance = new WebAssembly.Instance(module, { env: { memory, f: () => {} } });
	return {
		view: new Uint8Array(memory.buffer),
		bulk: instance.exports.bulk as (...a: number[]) => void
	};
};

interface Run {
	trapped: boolean;
	memory: Uint8Array;
}

export function runSerial(module: WebAssembly.Module, img: Uint8Array): Run {
	const { view, bulk } = instantiate(module, img);
	let trapped = false;
	try {
		bulk(TABLE, RECORDS, OUT);
	} catch {
		trapped = true;
	}
	return { trapped, memory: view.slice() };
}

export function runPrivate(
	module: WebAssembly.Module,
	img: Uint8Array,
	windows: { low: number; end: number }[]
): Run {
	const { view, bulk } = instantiate(module, img);
	const baseline = windows.map((w) => view.slice(w.low, w.end));
	let trapped = false;
	for (let i = 0; i < RECORDS; i++) {
		windows.forEach((w, k) => view.set(baseline[k]!, w.low));
		try {
			bulk(TABLE + 16 * i, 1, OUT + 64 * i);
		} catch {
			trapped = true;
			break;
		}
	}
	return { trapped, memory: view.slice() };
}

export const firstDiff = (a: Uint8Array, b: Uint8Array) => {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
	return -1;
};

const inStack = (at: number) => at >= STACK_TOP - 4096 && at < STACK_TOP;

// premise check: each record alone writes only its own slot, its arena slice, the windows and the
// stack zone, and gives the same slot when the other slots and slices hold other bytes
function recordsOwn(
	module: WebAssembly.Module,
	img: Uint8Array,
	windows: { low: number; end: number }[]
): { ok: boolean; why?: string } {
	const { view, bulk } = instantiate(module, img);
	const inWindow = (at: number) => windows.some((w) => at >= w.low && at < w.end);
	for (let i = 0; i < RECORDS; i++) {
		const before = view.slice();
		const slot = OUT + 64 * i;
		const arena = ARENAS + SLICE * i;
		const alone = instantiate(module, before);
		for (let a = OUT; a < OUT + 64 * RECORDS; a++)
			if (a < slot || a >= slot + 64) alone.view[a] = (a * 31 + 7) & 255;
		for (let j = 0; j < RECORDS; j++)
			if (j !== i)
				for (let k = 0; k < SLICE; k++)
					alone.view[ARENAS + SLICE * j + k] = (k * 17 + 5) & 255;
		let trapped = false;
		try {
			bulk(TABLE + 16 * i, 1, slot);
		} catch {
			trapped = true;
		}
		let trappedAlone = false;
		try {
			alone.bulk(TABLE + 16 * i, 1, slot);
		} catch {
			trappedAlone = true;
		}
		if (trapped !== trappedAlone)
			return { ok: false, why: `record ${i} trap depends on other slots` };
		for (let a = OUT; a < OUT + 64 * RECORDS; a++)
			if ((a < slot || a >= slot + 64) && alone.view[a] !== ((a * 31 + 7) & 255))
				return { ok: false, why: `record ${i} wrote slot byte ${a}` };
		for (let j = 0; j < RECORDS; j++)
			if (j !== i)
				for (let k = 0; k < SLICE; k++)
					if (alone.view[ARENAS + SLICE * j + k] !== ((k * 17 + 5) & 255))
						return { ok: false, why: `record ${i} wrote the arena of ${j}` };
		for (let at = 0; at < view.length; at++) {
			if (view[at] === before[at]) continue;
			const own =
				(at >= slot && at < slot + 64) ||
				(at >= arena && at < arena + SLICE) ||
				inWindow(at) ||
				inStack(at);
			if (!own) return { ok: false, why: `record ${i} wrote ${at}` };
		}
		const region = (v: Uint8Array) => [
			...v.subarray(slot, slot + 64),
			...v.subarray(arena, arena + SLICE),
			...windows.flatMap((w) => [...v.subarray(w.low, w.end)])
		];
		if (!trapped && region(view).join() !== region(alone.view).join())
			return { ok: false, why: `record ${i} reads another slot or slice` };
		if (trapped) break;
	}
	return { ok: true };
}

export function recordsOwnOf(
	bytes: Uint8Array,
	layoutSeed: number,
	windows: { low: number; end: number }[]
) {
	return recordsOwn(new WebAssembly.Module(Uint8Array.from(bytes)), image(layoutSeed), windows);
}

export interface Row {
	seed: number;
	mode?: string;
	skeleton: string;
	attacks: string[];
	outcome: string;
	detail?: string;
	private?: 'equal' | 'differs';
	route?: 'equal' | 'differs' | 'refused' | 'notRunnable' | 'timeout';
	ground?: 'equal' | 'differs' | 'timeout' | 'skipped';
	verdict?: 'ok' | 'false' | 'premise' | 'stack' | 'timeout' | 'wild';
	why?: string;
	windows?: string;
	traps?: boolean;
}

const call: SliceCall = {
	table: TABLE,
	n: RECORDS,
	out: OUT,
	slot: 64,
	regions: [
		[TABLE, TABLE + 16 * RECORDS],
		[DATA, DATA + 320 * RECORDS],
		[OUT, OUT + 64 * RECORDS],
		[ARENAS, ARENAS + SLICE * RECORDS]
	]
};
const WRITES: [number, number][] = [
	[OUT, OUT + 64 * RECORDS],
	[ARENAS, ARENAS + SLICE * RECORDS]
];

async function sliceTruth(bytes: Uint8Array, cert: OwnershipCertificate) {
	let rig;
	try {
		rig = await openSliceRig(bytes, cert, 8, 4, MAXPAGES);
	} catch (error) {
		return { route: 'notRunnable' as const, why: String(error).slice(0, 160) };
	}
	try {
		for (const seed of SEEDS) {
			const img = image(seed);
			const imports = { f: () => {} };
			const want = serialRun(rig, img, call, imports);
			const got = await slicesRun(rig, bootedImage(rig, img, imports), call, {
				writes: WRITES
			});
			const at = firstDiff(want.bytes, got.bytes);
			if (at !== -1 || !sameError(want.error, got.error))
				return {
					route: 'differs' as const,
					why: `slice seed ${seed} byte ${at}`,
					at,
					seed
				};
		}
		return { route: 'equal' as const };
	} finally {
		await closeSliceRig(rig);
	}
}

function groundWorker(bytes: Uint8Array, cert: OwnershipCertificate) {
	const input = JSON.stringify({
		bytes: Buffer.from(bytes).toString('base64'),
		cert: { windows: cert.windows, allocator: undefined },
		seeds: [1, 2, 3],
		lengths: EXTREME
	});
	const run = spawnSync(process.execPath, [worker], {
		input,
		timeout: 90000,
		maxBuffer: 1 << 24
	});
	if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT')
		return { ok: false, timeout: true, why: 'ground worker timeout' };
	try {
		const out = JSON.parse(run.stdout.toString()) as { ok: boolean; why?: string };
		return { ...out, timeout: false };
	} catch {
		return { ok: false, timeout: false, why: 'worker: ' + run.stderr.toString().slice(0, 200) };
	}
}

export async function evaluate(p: Plan): Promise<Row> {
	const row: Row = {
		seed: p.seed,
		mode: p.mode,
		skeleton: p.skeleton,
		attacks: p.attacks,
		outcome: ''
	};
	let bytes: Uint8Array;
	try {
		bytes = build(p);
	} catch (error) {
		row.outcome = 'invalid';
		row.detail = String((error as Error).message ?? error).slice(0, 120);
		return row;
	}
	const cert = certifyOwnership(bytes);
	if (cert.kind === 'refusal') {
		row.outcome = cert.reason;
		row.detail = cert.detail.replace(/\d+/g, 'N').slice(0, 100);
		return row;
	}
	row.outcome = 'certificate';
	row.windows = cert.windows.map((w) => `${w.low}-${w.end}`).join(',');
	const module = new WebAssembly.Module(Uint8Array.from(bytes));
	let priv: boolean;
	let traps = false;
	let privAt = -1;
	try {
		priv = true;
		for (const seed of SEEDS) {
			const img = image(seed);
			const serial = runSerial(module, img);
			const route = runPrivate(module, img, cert.windows);
			traps ||= serial.trapped;
			// a trap discards the private copies and the serial run decides, so only the trap is compared
			const at =
				serial.trapped && route.trapped ? -1 : firstDiff(serial.memory, route.memory);
			if (at !== -1 || serial.trapped !== route.trapped) {
				priv = false;
				privAt = at;
				break;
			}
		}
	} catch (error) {
		row.private = undefined;
		row.why = 'private: ' + String(error).slice(0, 100);
		row.verdict = 'timeout';
		return row;
	}
	row.traps = traps;
	row.private = priv ? 'equal' : 'differs';
	let routeDiffers = !priv;
	let why = priv ? '' : `private byte ${privAt}`;
	let at = priv ? -1 : privAt;
	let failSeed = SEEDS[0]!;
	if (cert.wildStores > 0) {
		row.route = 'refused';
	} else {
		const slice = await sliceTruth(bytes, cert);
		row.route = slice.route;
		if (slice.route === 'differs') {
			routeDiffers = true;
			why = why || slice.why!;
			at = at === -1 ? ((slice as { at?: number }).at ?? -1) : at;
			failSeed = (slice as { seed?: number }).seed ?? failSeed;
		}
		if (slice.route === 'notRunnable') row.why = slice.why;
	}
	const ground = groundWorker(bytes, cert);
	row.ground = ground.timeout ? 'timeout' : ground.ok ? 'equal' : 'differs';
	if (!ground.ok) {
		routeDiffers = true;
		why = why || ground.why || 'ground';
	}
	if (ground.timeout) {
		row.verdict = 'timeout';
		row.why = why;
		return row;
	}
	if (!routeDiffers) {
		row.verdict = cert.wildStores > 0 ? 'wild' : 'ok';
		return row;
	}
	row.why = why;
	const own = recordsOwn(module, image(failSeed), cert.windows);
	const own2 = own.ok ? recordsOwn(module, image(SEEDS[1]!), cert.windows) : own;
	if (!own2.ok) {
		row.verdict = 'premise';
		row.why = `${why}; ${own2.why}`;
	} else if (at >= 0 && inStack(at)) {
		row.verdict = 'stack';
	} else row.verdict = 'false';
	return row;
}

// #region runner

const OUTFILE = process.argv[4];

async function chunk(start: number, end: number, out: string, attack: number) {
	for (let s = start; s < end; s++) {
		const row = await evaluate(plan(s, { ...DEFAULT_WEIGHTS, attack }));
		appendFileSync(out, JSON.stringify(row) + '\n');
	}
}

function watch(start: number, end: number, out: string, attack: number): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[
				new URL(import.meta.url).pathname,
				'chunk',
				String(start),
				String(end),
				out,
				String(attack)
			],
			{ stdio: ['ignore', 'ignore', 'inherit'] }
		);
		let size = statSync(out).size;
		let idle = 0;
		const timer = setInterval(() => {
			const now = statSync(out).size;
			idle = now === size ? idle + 5 : 0;
			size = now;
			if (idle >= 120) child.kill('SIGKILL');
		}, 5000);
		child.on('exit', (code) => {
			clearInterval(timer);
			resolve(code ?? 1);
		});
	});
}

async function run(start: number, count: number, out: string, attack: number) {
	if (!existsSync(out)) writeFileSync(out, '');
	const end = start + count;
	let at = start;
	while (at < end) {
		const to = Math.min(end, at + 200);
		const code = await watch(at, to, out, attack);
		if (code === 0) {
			at = to;
			continue;
		}
		const rows = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean);
		const last = rows.length ? (JSON.parse(rows[rows.length - 1]!) as Row).seed : at - 1;
		const hung = Math.max(at, last + 1);
		const hungPlan = plan(hung, { ...DEFAULT_WEIGHTS, attack });
		appendFileSync(
			out,
			JSON.stringify({
				seed: hung,
				skeleton: hungPlan.skeleton,
				attacks: hungPlan.attacks,
				outcome: 'timeout',
				verdict: 'timeout'
			}) + '\n'
		);
		at = hung + 1;
	}
}

// #endregion

// #region minimize and summary

function planWat(p: Plan) {
	return wat(p);
}

async function lies(p: Plan): Promise<boolean> {
	let bytes: Uint8Array;
	try {
		bytes = assemble(planWat(p));
	} catch {
		return false;
	}
	const row = await evaluate(p);
	return row.outcome === 'certificate' && row.verdict === 'false';
}

async function minimize(seed: number, dir: string) {
	let p = plan(seed);
	if (!(await lies(p))) {
		console.log('seed does not lie (verdict differs)');
		return;
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = p.statements.length - 1; i >= 0; i--) {
			const next = { ...p, statements: p.statements.filter((_, k) => k !== i) };
			if (await lies(next)) {
				p = next;
				changed = true;
			}
		}
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/seed-${seed}.wat`, planWat(p));
	writeFileSync(`${dir}/seed-${seed}.wasm`, build(p));
	console.log(planWat(p));
	console.log('statements left', p.statements.length);
}

function summary(file: string) {
	const rows = readFileSync(file, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Row);
	const count = (f: (r: Row) => string | undefined) => {
		const m = new Map<string, number>();
		for (const r of rows) {
			const k = f(r);
			if (k !== undefined) m.set(k, (m.get(k) ?? 0) + 1);
		}
		return [...m].sort((a, b) => b[1] - a[1]);
	};
	const accepted = rows.filter((r) => r.outcome === 'certificate');
	console.log(
		JSON.stringify({
			rows: rows.length,
			accepted: accepted.length,
			verdicts: count((r) => (r.outcome === 'certificate' ? r.verdict : undefined)),
			routes: count((r) => r.route),
			refusals: count((r) => (r.outcome !== 'certificate' ? r.outcome : undefined))
		})
	);
	const detail = count((r) =>
		r.outcome !== 'certificate' ? `${r.outcome}: ${r.detail ?? ''}` : undefined
	);
	for (const [k, v] of detail.slice(0, 20)) console.log(v, k);
	for (const r of rows.filter((r) => r.verdict === 'false' || r.verdict === 'premise'))
		console.log(r.verdict?.toUpperCase(), r.seed, r.skeleton, r.attacks.join('+'), r.why);
}

// #endregion

const [command, a, b, c, d] = process.argv.slice(2);
if (!import.meta.main) void 0;
else if (command === 'run')
	await run(Number(a), Number(b), c!, Number(d ?? DEFAULT_WEIGHTS.attack));
else if (command === 'chunk') await chunk(Number(a), Number(b), c!, Number(d));
else if (command === 'one') console.log(JSON.stringify(await evaluate(plan(Number(a))), null, 1));
else if (command === 'minimize') await minimize(Number(a), b!);
else if (command === 'summary') summary(a!);
void OUTFILE;
