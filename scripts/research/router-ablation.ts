import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from '../../src/compiler.ts';
import { admissionSeam } from '../../src/iteration-admission.ts';
import { Folio } from '../../src/node.ts';
import {
	CertificateCache,
	decide,
	Router,
	routerConstants,
	type RecordsCall,
	type RouterCall,
	type RouterMode,
	type RouterOptions
} from '../../src/router.ts';
import { assemble } from './ownership-modules.ts';

// usage:
//   router-ablation.ts run MANIFEST OUT.jsonl [--modes a,b] [--rounds N] [--workers N] [--drivers x,y]
//                      [--cache FILE] [--warm N] [--resume] [--final]
//   router-ablation.ts certify MANIFEST CACHE.json OUT.jsonl [--reps N] [--drivers x,y] [--final]
//   router-ablation.ts summary OUT.jsonl [--json FILE]
// one fresh process per driver, arm and round; arms are interleaved and rotated per round

const root = fileURLToPath(new URL('../../', import.meta.url));
export const FINAL_DIR = join(root, 'scripts/research/final-cases');
export const ARMS = ['serial', 'today', 'w1', 'w2', 'independent', 'shared', 'router'] as const;
export type Arm = (typeof ARMS)[number];
const here = fileURLToPath(import.meta.url);

// #region manifest and the final-corpus guard

export interface DriverEntry {
	id: string;
	kind: 'c21' | 'final' | 'stream';
	records?: number;
	slot?: number;
	/** `stream` entries: the hand module and the stream length. */
	module?: string;
	bytes?: number;
}

/**
 * Refuses a manifest under the final corpus directory unless the run asks for it and the freeze
 * file exists. This is the one check between a development run and an early look at the corpus.
 */
export function guardManifest(
	path: string,
	options: { final?: boolean; finalDir?: string } = {}
): void {
	const finalDir = resolve(options.finalDir ?? FINAL_DIR);
	const full = existsSync(path) ? realpathSync(path) : resolve(path);
	const dir = existsSync(finalDir) ? realpathSync(finalDir) : finalDir;
	if (full !== dir && !full.startsWith(dir + sep)) return;
	if (!options.final) throw new Error(`${path} is under the final corpus: pass --final`);
	if (!existsSync(join(dir, 'prereg', 'FROZEN')))
		throw new Error(`${path} is under the final corpus and prereg/FROZEN does not exist`);
}

/** Reads a development manifest or a final-manifest and returns its drivers. */
export function loadManifest(
	path: string,
	options: { final?: boolean; finalDir?: string } = {}
): DriverEntry[] {
	guardManifest(path, options);
	const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	const seen = new Set<string>();
	const entries: DriverEntry[] = [];
	const add = (entry: DriverEntry) => {
		if (seen.has(entry.id)) throw new Error(`duplicate driver ${entry.id}`);
		seen.add(entry.id);
		entries.push(entry);
	};
	if (
		Array.isArray(json.projects) &&
		(json.projects as { drivers?: unknown }[]).some((p) => Array.isArray(p.drivers))
	) {
		for (const project of json.projects as { drivers?: unknown[] }[])
			for (const driver of (project.drivers ?? []) as Record<string, unknown>[]) {
				if (typeof driver.id !== 'string' || typeof driver.records !== 'number')
					throw new Error('a final driver needs an id and a record count');
				add({
					id: driver.id,
					kind: 'final',
					records: driver.records,
					slot: Number(driver.slot)
				});
			}
	} else if (Array.isArray(json.rows)) {
		for (const row of json.rows as { id: string }[]) add({ id: row.id, kind: 'c21' });
	} else if (Array.isArray(json.cases) || Array.isArray(json.bulkCases)) {
		for (const row of [
			...((json.cases as { id: string }[]) ?? []),
			...((json.bulkCases as { id: string }[]) ?? [])
		])
			add({ id: row.id, kind: 'c21' });
	} else if (Array.isArray(json.drivers)) {
		for (const row of json.drivers as DriverEntry[]) add({ ...row });
	} else throw new Error(`${path} is not a driver manifest`);
	return entries;
}

// #endregion

// #region statistics

export const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
export const geomean = (values: number[]) =>
	Math.exp(values.reduce((sum, v) => sum + Math.log(v), 0) / values.length);

const mulberry = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Median of the values with the min, the max and a seeded 95 percent bootstrap interval of the median. */
export function interval(values: number[]) {
	const next = mulberry(12345);
	const boots = Array.from({ length: 2000 }, () =>
		median(values.map(() => values[Math.floor(next() * values.length)]!))
	).sort((a, b) => a - b);
	return {
		median: median(values),
		min: Math.min(...values),
		max: Math.max(...values),
		lo: boots[Math.floor(0.025 * boots.length)]!,
		hi: boots[Math.floor(0.975 * boots.length) - 1]!,
		n: values.length
	};
}

/** The first byte at which two outputs differ, or -1. */
export function firstDifference(expected: Uint8Array, actual: Uint8Array): number {
	if (expected.length !== actual.length) return Math.min(expected.length, actual.length);
	for (let i = 0; i < expected.length; i++) if (expected[i] !== actual[i]) return i;
	return -1;
}

// #endregion

// #region summary

export interface Sample {
	kind: 'sample';
	driver: string;
	arm: Arm;
	round: number;
	wallMs: number;
	passed: boolean;
	route?: string;
	reason?: string;
	decision?: { route: string; reason: string };
	certifyMs?: number;
	setupMs?: number;
	openMs?: number;
	firstRunMs?: number;
	dispatched?: boolean;
	load?: number[];
	firstDifference?: number;
}

export interface DriverRow {
	driver: string;
	route: string;
	reason: string;
	serialMs: number;
	armMs: number;
	speedup: ReturnType<typeof interval>;
	wrong: number;
}

/** Paired ratios per driver for one arm against serial; the pairing is by round. */
export function summarize(samples: Sample[], arms: Arm[]) {
	const by = new Map<string, Sample[]>();
	for (const s of samples) {
		const key = `${s.driver}\t${s.arm}`;
		by.set(key, [...(by.get(key) ?? []), s]);
	}
	const drivers = [...new Set(samples.map((s) => s.driver))];
	const out: Record<string, DriverRow[]> = {};
	const wrong: Sample[] = [];
	for (const arm of arms) {
		out[arm] = [];
		for (const driver of drivers) {
			const mine = by.get(`${driver}\t${arm}`) ?? [];
			const base = by.get(`${driver}\tserial`) ?? [];
			wrong.push(...mine.filter((s) => !s.passed));
			const ratios: number[] = [];
			for (const s of mine) {
				const partner = base.find((b) => b.round === s.round);
				if (partner) ratios.push(partner.wallMs / s.wallMs);
			}
			if (!ratios.length) continue;
			const route = mine.map((s) => s.route ?? '-');
			out[arm]!.push({
				driver,
				route: mode(route),
				reason: mode(mine.map((s) => s.reason ?? '-')),
				serialMs: median(base.map((b) => b.wallMs)),
				armMs: median(mine.map((s) => s.wallMs)),
				speedup: interval(ratios),
				wrong: mine.filter((s) => !s.passed).length
			});
		}
	}
	const totals = Object.fromEntries(
		arms.map((arm) => {
			const speeds = out[arm]!.map((r) => r.speedup.median);
			const sorted = [...speeds].sort((a, b) => a - b);
			const slow = Math.max(1, Math.ceil(0.1 * sorted.length));
			return [
				arm,
				{
					drivers: speeds.length,
					geomean: speeds.length ? geomean(speeds) : NaN,
					p10: sorted[Math.max(0, Math.ceil(0.1 * sorted.length) - 1)] ?? NaN,
					slowest: out[arm]!.slice()
						.sort((a, b) => a.speedup.median - b.speedup.median)
						.slice(0, slow)
						.map((r) => `${r.driver} ${r.speedup.median.toFixed(3)}`)
				}
			];
		})
	);
	return { rows: out, totals, wrong };
}

export interface CertifyRow {
	driver: string;
	mode: string;
	certifyMs: number;
	route: string;
	reason: string;
}

const rowsOf = (samples: Sample[], driver: string, arm: string) =>
	samples.filter((s) => s.driver === driver && s.arm === arm);

const pairedRatios = (samples: Sample[], driver: string, arm: string) =>
	rowsOf(samples, driver, arm).flatMap((s) => {
		const partner = rowsOf(samples, driver, 'serial').find((b) => b.round === s.round);
		return partner ? [s.wallMs / partner.wallMs] : [];
	});

/** Time of the path that ran over serial time, for the drivers where today's route did not dispatch. */
export function refusalOverhead(samples: Sample[]) {
	const rows = [...new Set(samples.map((s) => s.driver))].flatMap((driver) => {
		const today = rowsOf(samples, driver, 'today');
		if (!today.length || today.filter((s) => s.dispatched).length * 2 >= today.length)
			return [];
		const router = pairedRatios(samples, driver, 'router');
		if (!router.length) return [];
		return [
			{
				driver,
				before: interval(pairedRatios(samples, driver, 'today')),
				after: interval(router),
				path: mode(rowsOf(samples, driver, 'router').map((s) => s.route ?? '-'))
			}
		];
	});
	return {
		rows,
		before: rows.length ? geomean(rows.map((r) => r.before.median)) : NaN,
		after: rows.length ? geomean(rows.map((r) => r.after.median)) : NaN
	};
}

/** Offline certification, first-use setup, steady state and the calls it takes to pay them back. */
export function costTable(samples: Sample[], certify: CertifyRow[]) {
	return [...new Set(samples.map((s) => s.driver))].flatMap((driver) => {
		const mine = rowsOf(samples, driver, 'router');
		const serial = rowsOf(samples, driver, 'serial');
		if (!mine.length || !serial.length) return [];
		const cert = certify.filter((c) => c.driver === driver && c.mode === 'independent');
		const certifyMs = cert.length ? median(cert.map((c) => c.certifyMs)) : NaN;
		const steady = median(mine.map((s) => s.wallMs));
		const serialMs = median(serial.map((s) => s.wallMs));
		const setup = median(mine.map((s) => s.openMs ?? 0));
		const first = median(mine.map((s) => Math.max(0, (s.firstRunMs ?? s.wallMs) - s.wallMs)));
		return [
			{
				driver,
				route: mode(mine.map((s) => s.route ?? '-')),
				certifyMs,
				setupMs: setup,
				firstExtraMs: first,
				steadyMs: steady,
				serialMs,
				breakEvenCalls:
					steady < serialMs ? (certifyMs + setup + first) / (serialMs - steady) : Infinity
			}
		];
	});
}

/** Certification time of the two analysis modes and whether their routes and outputs agree. */
export function sharedVsIndependent(samples: Sample[], certify: CertifyRow[]) {
	return [...new Set(certify.map((c) => c.driver))].map((driver) => {
		const time = (m: string) =>
			median(
				certify.filter((c) => c.driver === driver && c.mode === m).map((c) => c.certifyMs)
			);
		const routeOf = (m: string) =>
			certify.find((c) => c.driver === driver && c.mode === m)?.reason;
		const ran = (m: string) => rowsOf(samples, driver, m);
		return {
			driver,
			independentMs: time('independent'),
			sharedMs: time('shared'),
			sameDecision: routeOf('independent') === routeOf('shared'),
			sameRoute:
				mode(ran('independent').map((s) => s.route ?? '-')) ===
				mode(ran('shared').map((s) => s.route ?? '-')),
			wrong: ran('independent')
				.concat(ran('shared'))
				.filter((s) => !s.passed).length
		};
	});
}

function mode(values: string[]): string {
	const count = new Map<string, number>();
	for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
	return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';
}

// #endregion

// #region drivers

async function c21(id: string) {
	const kernels = await import('./c21-kernels.ts');
	const common = await import('./c21-common.ts');
	const spec = common.specOf(id);
	const n = Number(process.env.C21_N ?? spec.n);
	const records = common.recordsOf(spec, n);
	const layout = kernels.layoutOf(
		spec,
		n,
		records.map((r) => r.input.length)
	);
	const copies = spec.config?.perRecord ? n : 1;
	const regions: [number, number][] = [
		[layout.table, layout.table + 16 * n],
		[layout.aux, layout.aux + n * spec.auxBytes],
		[layout.out, layout.out + n * spec.slot],
		[layout.data, layout.end]
	];
	const writes: [number, number][] = [[layout.out, layout.out + n * spec.slot]];
	if (spec.config) regions.push([layout.config, layout.config + copies * spec.config.stride]);
	if (spec.arena) {
		regions.push([layout.arena, layout.arena + n * spec.arena]);
		writes.push([layout.arena, layout.arena + n * spec.arena]);
	}
	const call: RecordsCall = {
		kind: 'records',
		entry: 'bulk',
		count: n,
		args: (from, to) => [layout.table + 16 * from, to - from, layout.out + from * spec.slot],
		regions: regions.filter(([a, b]) => b > a),
		writes
	};
	const setupArgs = [layout.config, copies, spec.config?.nfft ?? 0];
	return {
		spec,
		n,
		records,
		layout,
		call,
		bytes: common.moduleBytes(spec),
		setupArgs,
		write: (memory: WebAssembly.Memory) => common.writeRecords(memory, spec, layout, records),
		clear: (memory: WebAssembly.Memory) => common.clearOutput(memory, spec, layout, n),
		output: (memory: WebAssembly.Memory) =>
			Uint8Array.from(common.outputOf(memory, spec, layout, n)),
		imports: new URL('./c21-imports.ts', import.meta.url),
		hostMath: common.hostMath
	};
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// hand stream modules for the summary route: the entry is `poly(state, ptr, len)`
const STREAM_WAT = (mix: string) => `(module
	(memory (export "memory") 32 4096)
	(func (export "poly") (param $s i32) (param $p i32) (param $n i32) (result i32)
		(local $i i32)
		(block $done (loop $each
			(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
			(local.set $s ${mix})
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br $each)))
		(local.get $s)))`;
const BYTE = '(i32.load8_u (i32.add (local.get $p) (local.get $i)))';
export const HAND_STREAMS: Record<string, string> = {
	poly: STREAM_WAT(`(i32.add (i32.mul (local.get $s) (i32.const 31)) ${BYTE})`),
	rotxor: STREAM_WAT(`(i32.xor (i32.rotl (local.get $s) (i32.const 5)) ${BYTE})`)
};
const STREAM_AT = 1 << 20;

async function serialExpected(entry: DriverEntry): Promise<string> {
	if (entry.kind === 'stream') {
		const bytes = assemble(HAND_STREAMS[entry.module!]!);
		const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
		const memory = exports.memory as WebAssembly.Memory;
		memory.grow(
			Math.max(
				0,
				Math.ceil((STREAM_AT + entry.bytes!) / 65536) + 1 - memory.buffer.byteLength / 65536
			)
		);
		fillStream(new Uint8Array(memory.buffer, STREAM_AT, entry.bytes!));
		const end = (exports.poly as (...a: number[]) => number)(0, STREAM_AT, entry.bytes!);
		return String(end >>> 0);
	}
	if (entry.kind !== 'c21') throw new Error('final drivers are not run in this lane');
	const d = await c21(entry.id);
	const memory = new WebAssembly.Memory({ initial: d.layout.pages, maximum: d.layout.pages });
	const instance = new WebAssembly.Instance(new WebAssembly.Module(d.bytes), {
		env: { memory, ...d.hostMath() }
	});
	const exports = instance.exports as Record<string, (...a: number[]) => unknown>;
	if (d.spec.config) exports.setup!(...d.setupArgs);
	d.write(memory);
	d.clear(memory);
	exports.bulk!(d.layout.table, d.n, d.layout.out);
	return digest(d.output(memory));
}

const fillStream = (view: Uint8Array) => {
	for (let i = 0; i < view.length; i++) view[i] = (Math.imul(i, 2654435761) >>> 24) & 255;
};

// #endregion

// #region child: one arm in a fresh process

interface ChildArgs {
	entry: DriverEntry;
	arm: Arm;
	round: number;
	workers: number;
	warm: number;
	cache?: string;
	expected: string;
	manifest: string;
	final?: boolean;
	floors?: RouterOptions['floors'];
}

const emitRow = (row: Record<string, unknown>) => console.log('ROW ' + JSON.stringify(row));

async function child(args: ChildArgs): Promise<void> {
	guardManifest(args.manifest, { final: args.final });
	if (args.entry.kind === 'final') throw new Error('final drivers are not run in this lane');
	const cache = new CertificateCache();
	if (args.cache && existsSync(args.cache)) cache.load(readFileSync(args.cache, 'utf8'));
	const loadStart = loadavg()[0]!;
	const base = { kind: 'sample', driver: args.entry.id, arm: args.arm, round: args.round };
	if (args.entry.kind === 'stream') return childStream(args, cache, base);
	const d = await c21(args.entry.id);
	const memoryPlain = () =>
		new WebAssembly.Memory({ initial: d.layout.pages, maximum: d.layout.pages });
	let run: () => Promise<Record<string, unknown>>;
	let memory: WebAssembly.Memory;
	let close = async () => {};
	let extra: Record<string, unknown> = {};
	const opened = performance.now();
	if (args.arm === 'serial') {
		memory = memoryPlain();
		const instance = new WebAssembly.Instance(new WebAssembly.Module(d.bytes), {
			env: { memory, ...d.hostMath() }
		});
		const exports = instance.exports as Record<string, (...a: number[]) => unknown>;
		if (d.spec.config) exports.setup!(...d.setupArgs);
		d.write(memory);
		run = async () => {
			exports.bulk!(d.layout.table, d.n, d.layout.out);
			return { route: 'serial', reason: 'baseline' };
		};
	} else if (args.arm === 'today') {
		const eligible = prepare(d.bytes).iterationRoute?.eligible;
		const refused = eligible === false;
		const shared = new WebAssembly.Memory({
			initial: d.layout.pages,
			maximum: refused ? d.layout.pages : 65536,
			shared: !refused
		});
		const env = { memory: shared, ...(d.spec.imports ? d.hostMath() : {}) };
		const pool = await Folio.open(
			d.bytes,
			refused
				? { imports: { env }, workers: args.workers }
				: {
						memory: shared,
						workers: args.workers,
						imports: d.spec.imports ? { env: d.hostMath() } : undefined
					}
		);
		memory = pool.memory;
		if (d.spec.config) await pool.run('setup', d.setupArgs);
		d.write(memory);
		close = () => pool.close();
		run = async () => {
			admissionSeam.force = process.env.FORCE_ADMISSION === '1';
			const report = await pool.run('bulk', [d.layout.table, d.n, d.layout.out]);
			const it = report.iteration;
			return {
				route: 'tracked',
				reason: report.reason ?? it?.stopped ?? 'ran',
				dispatched: Boolean(it?.batches),
				regions: it?.regions,
				stopped: it?.stopped,
				mode: report.mode
			};
		};
	} else {
		const options: RouterOptions = {
			mode: args.arm as RouterMode,
			pages: d.layout.pages,
			workers: args.workers,
			cache,
			imports: d.spec.imports ? d.imports : undefined,
			assume: { importsDeterministic: true, residueUnobserved: true },
			floors: args.floors
		};
		const router = await Router.open(d.bytes, d.call, options);
		memory = router.memory;
		if (d.spec.config) router.exec('setup', d.setupArgs);
		d.write(memory);
		close = () => router.close();
		extra = {
			decision: {
				route: router.decision.route,
				reason: router.decision.reason,
				detail: router.decision.detail,
				analyses: router.decision.analyses,
				cacheHit: router.decision.cacheHit
			},
			certifyMs: router.decision.certifyMs,
			setupMs: router.setupMs
		};
		run = async () => {
			const result = await router.run();
			return {
				route: result.route,
				reason: result.reason,
				probeMs: result.probeMs,
				dispatched:
					result.route === 'tracked'
						? Boolean(
								(result.tracked?.iteration as { batches?: number } | undefined)
									?.batches
							)
						: result.route !== 'serial',
				tracked: result.tracked && {
					mode: result.tracked.mode,
					reason: result.tracked.reason
				}
			};
		};
	}
	const openMs = performance.now() - opened;
	try {
		let firstRunMs = 0;
		for (let i = 0; i < args.warm; i++) {
			d.clear(memory);
			const t = performance.now();
			await run();
			if (i === 0) firstRunMs = performance.now() - t;
		}
		d.clear(memory);
		const t = performance.now();
		const result = await run();
		const wallMs = performance.now() - t;
		const out = d.output(memory);
		const passed = digest(out) === args.expected;
		emitRow({
			...base,
			wallMs,
			firstRunMs,
			openMs,
			...extra,
			...result,
			passed,
			load: [loadStart]
		});
	} finally {
		await close();
	}
}

async function childStream(
	args: ChildArgs,
	cache: CertificateCache,
	base: Record<string, unknown>
) {
	const entry = args.entry;
	const bytes = assemble(HAND_STREAMS[entry.module!]!);
	const pages = Math.max(32, Math.ceil((STREAM_AT + entry.bytes!) / 65536) + 1);
	const call: RouterCall = { kind: 'stream', entry: 'poly', ptr: STREAM_AT, len: entry.bytes! };
	const opened = performance.now();
	const router = await Router.open(bytes, call, {
		mode: args.arm === 'today' ? 'serial' : (args.arm as RouterMode),
		pages,
		workers: args.workers,
		cache,
		floors: args.floors
	});
	const openMs = performance.now() - opened;
	try {
		if (router.memory.buffer.byteLength < pages * 65536)
			router.memory.grow(pages - router.memory.buffer.byteLength / 65536);
		fillStream(new Uint8Array(router.memory.buffer, STREAM_AT, entry.bytes!));
		let firstRunMs = 0;
		for (let i = 0; i < args.warm; i++) {
			const t = performance.now();
			await router.run();
			if (i === 0) firstRunMs = performance.now() - t;
		}
		const t = performance.now();
		const result = await router.run();
		const wallMs = performance.now() - t;
		emitRow({
			...base,
			wallMs,
			firstRunMs,
			openMs,
			setupMs: router.setupMs,
			certifyMs: router.decision.certifyMs,
			decision: { route: router.decision.route, reason: router.decision.reason },
			route: result.route,
			reason: result.reason,
			dispatched: result.route !== 'serial',
			passed: String(result.state) === args.expected,
			load: [loadavg()[0]]
		});
	} finally {
		await router.close();
	}
}

// #endregion

// #region parent

const flag = (argv: string[], name: string) => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};

function spawnChild(args: ChildArgs): Record<string, unknown> {
	const t0 = Date.now() / 1000;
	const result = spawnSync(process.execPath, [here, 'child', JSON.stringify(args)], {
		encoding: 'utf8',
		maxBuffer: 1 << 26,
		timeout: 900_000
	});
	const t1 = Date.now() / 1000;
	const line = result.stdout.split('\n').find((l) => l.startsWith('ROW '));
	if (!line)
		return {
			kind: 'error',
			driver: args.entry.id,
			arm: args.arm,
			round: args.round,
			status: result.status,
			signal: result.signal,
			stderr: result.stderr.slice(-600),
			t0,
			t1
		};
	return { ...(JSON.parse(line.slice(4)) as Record<string, unknown>), t0, t1 };
}

async function main(argv: string[]) {
	const [command, ...rest] = argv;
	if (command === 'child') return child(JSON.parse(rest[0]!));
	if (command === 'summary') {
		const rows = readFileSync(rest[0]!, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((r) => r.kind === 'sample') as Sample[];
		const arms = ARMS.filter((arm) => rows.some((r) => r.arm === arm));
		const result = summarize(rows, arms);
		const lines: string[] = [];
		for (const arm of arms) {
			lines.push(`## ${arm}`);
			for (const r of result.rows[arm]!)
				lines.push(
					`${r.driver.padEnd(26)} ${r.route.padEnd(8)} ${r.reason.padEnd(24)} serial ${r.serialMs.toFixed(3)} ms  ${r.speedup.median.toFixed(3)} (${r.speedup.min.toFixed(3)} to ${r.speedup.max.toFixed(3)}; ci ${r.speedup.lo.toFixed(3)} to ${r.speedup.hi.toFixed(3)})${r.wrong ? ' WRONG ' + r.wrong : ''}`
				);
			const t = result.totals[arm]!;
			lines.push(
				`geomean ${t.geomean.toFixed(3)} p10 ${t.p10.toFixed(3)} slowest ${t.slowest.join(', ')}`
			);
		}
		lines.push(`wrong outputs: ${result.wrong.length}`);
		const certifyFile = flag(rest, '--certify');
		const certify = certifyFile
			? (readFileSync(certifyFile, 'utf8')
					.split('\n')
					.filter(Boolean)
					.map((l) => JSON.parse(l)) as CertifyRow[])
			: [];
		const refusal = refusalOverhead(rows);
		lines.push('## refusal overhead (time over serial, drivers today did not dispatch)');
		for (const r of refusal.rows)
			lines.push(
				`${r.driver.padEnd(26)} today ${r.before.median.toFixed(3)} (${r.before.min.toFixed(3)} to ${r.before.max.toFixed(3)}; ci ${r.before.lo.toFixed(3)} to ${r.before.hi.toFixed(3)})  router[${r.path}] ${r.after.median.toFixed(3)} (${r.after.min.toFixed(3)} to ${r.after.max.toFixed(3)}; ci ${r.after.lo.toFixed(3)} to ${r.after.hi.toFixed(3)})`
			);
		lines.push(`geomean today ${refusal.before.toFixed(3)} router ${refusal.after.toFixed(3)}`);
		lines.push('## cost (router arm)');
		for (const c of costTable(rows, certify))
			lines.push(
				`${c.driver.padEnd(26)} ${c.route.padEnd(8)} certify ${c.certifyMs.toFixed(1)} ms  setup ${c.setupMs.toFixed(1)} ms  first-run extra ${c.firstExtraMs.toFixed(2)} ms  steady ${c.steadyMs.toFixed(3)} ms  serial ${c.serialMs.toFixed(3)} ms  break-even ${c.breakEvenCalls.toFixed(1)} calls`
			);
		lines.push('## shared against independent');
		for (const c of sharedVsIndependent(rows, certify))
			lines.push(
				`${c.driver.padEnd(26)} independent ${c.independentMs.toFixed(2)} ms  shared ${c.sharedMs.toFixed(2)} ms  same decision ${c.sameDecision}  same route ${c.sameRoute}  wrong ${c.wrong}`
			);
		console.log(lines.join('\n'));
		const out = flag(rest, '--json');
		if (out) {
			const tables = {
				...result,
				refusal,
				cost: costTable(rows, certify),
				shared: sharedVsIndependent(rows, certify)
			};
			writeFileSync(out, JSON.stringify(tables, null, '\t') + '\n');
		}
		return;
	}
	const [manifest, output] = rest;
	if (!manifest || !output) throw new Error('usage: router-ablation.ts run|certify MANIFEST OUT');
	const final = rest.includes('--final');
	const only = flag(rest, '--drivers')?.split(',');
	const entries = loadManifest(manifest, { final }).filter((e) => !only || only.includes(e.id));
	if (command === 'certify') {
		const cachePath = output;
		const outFile = rest[2]!;
		const reps = Number(flag(rest, '--reps') ?? 3);
		const persistent = new CertificateCache();
		if (existsSync(cachePath)) persistent.load(readFileSync(cachePath, 'utf8'));
		for (const entry of entries) {
			if (entry.kind !== 'c21') continue;
			const d = await c21(entry.id);
			for (let rep = 0; rep < reps; rep++)
				for (const mode of (rep % 2
					? ['shared', 'independent']
					: ['independent', 'shared']) as RouterMode[]) {
					const plan = decide(d.bytes, d.call, {
						mode,
						pages: d.layout.pages,
						workers: 8,
						cache: new CertificateCache()
					});
					appendFileSync(
						outFile,
						JSON.stringify({
							kind: 'certify',
							driver: entry.id,
							mode,
							rep,
							certifyMs: plan.decision.certifyMs,
							route: plan.decision.route,
							reason: plan.decision.reason,
							analyses: plan.decision.analyses
						}) + '\n'
					);
				}
			decide(d.bytes, d.call, {
				mode: 'router',
				pages: d.layout.pages,
				workers: 8,
				cache: persistent,
				assume: { importsDeterministic: true, residueUnobserved: true }
			});
			writeFileSync(cachePath, persistent.serialize());
		}
		return;
	}
	if (command !== 'run') throw new Error(`unknown command ${command}`);
	const rounds = Number(flag(rest, '--rounds') ?? 5);
	const workers = Number(flag(rest, '--workers') ?? 8);
	const warm = Number(flag(rest, '--warm') ?? 6);
	const arms = (flag(rest, '--modes')?.split(',') ?? [...ARMS]) as Arm[];
	if (!arms.includes('serial')) arms.unshift('serial');
	const cache = flag(rest, '--cache');
	const floorsText = flag(rest, '--floors');
	const floors = floorsText ? (JSON.parse(floorsText) as RouterOptions['floors']) : undefined;
	const done = new Set<string>();
	if (existsSync(output) && rest.includes('--resume'))
		for (const line of readFileSync(output, 'utf8').split('\n').filter(Boolean)) {
			const r = JSON.parse(line);
			if (r.kind === 'sample') done.add(`${r.driver}\t${r.arm}\t${r.round}`);
		}
	else writeFileSync(output, '', { flag: 'wx' });
	const expected = new Map<string, string>();
	for (const entry of entries) expected.set(entry.id, await serialExpected(entry));
	for (let round = 0; round < rounds; round++)
		for (const [index, entry] of entries.entries()) {
			const turn = (round + index) % arms.length;
			for (const arm of [...arms.slice(turn), ...arms.slice(0, turn)]) {
				if (done.has(`${entry.id}\t${arm}\t${round}`)) continue;
				const row = spawnChild({
					entry,
					arm,
					round,
					workers,
					warm,
					cache,
					expected: expected.get(entry.id)!,
					manifest,
					final,
					floors
				});
				appendFileSync(output, JSON.stringify(row) + '\n');
				if (row.kind === 'sample' && !row.passed)
					console.error(`WRONG OUTPUT ${entry.id} ${arm} round ${round}`);
			}
		}
	console.log('done', output, JSON.stringify(routerConstants));
}

if (import.meta.main) await main(process.argv.slice(2));

// #endregion
