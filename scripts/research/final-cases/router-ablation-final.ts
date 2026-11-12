import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CertificateCache,
	decide,
	Router,
	ROUTER_VERSION,
	routerConstants,
	type RecordsCall,
	type RouterDecision,
	type RouterMode,
	type RouterOptions
} from '../../../src/router.ts';
import {
	ARMS,
	FINAL_DIR,
	guardManifest,
	summarize,
	type Arm,
	type Sample
} from '../router-ablation.ts';
import {
	combined,
	layoutOf,
	loadWasm,
	slotDigests,
	type Driver,
	type Layout,
	type Manifest
} from './build-drivers.ts';

// usage:
//   router-ablation-final.ts run MANIFEST OUT.jsonl --final [--session N] [--rounds N] [--workers N]
//                            [--warm N] [--modes a,b] [--drivers x,y] [--cache FILE] [--build DIR]
//                            [--seed N] [--floors JSON] [--resume] [--dry]
//   router-ablation-final.ts certify MANIFEST CACHE.json OUT.jsonl --final [--reps N] [--drivers x,y]
//                            [--build DIR]
//   router-ablation-final.ts summary OUT.jsonl [--json FILE]
// the drivers are the ones prereg/draw.json lists; one fresh process per driver, arm and round

const root = fileURLToPath(new URL('../../../', import.meta.url));
const here = fileURLToPath(import.meta.url);
export const BUILD_DIR = join(root, 'build/research/final');
export const FINAL_ARMS: Arm[] = ARMS.filter((arm) => arm !== 'today');
const PAGE = 65536;
const ASSUME = { importsDeterministic: true, residueUnobserved: true };

type Memory = Manifest['memory'];

export interface FinalOptions {
	final?: boolean;
	finalDir?: string;
}

// #region manifest, guard and layout

// the dev guard, plus --final and the freeze file are required
export function guardFinal(path: string, options: FinalOptions = {}): void {
	guardManifest(path, options);
	if (!options.final) throw new Error('the final adapter runs only with --final');
	const dir = resolve(options.finalDir ?? FINAL_DIR);
	if (!existsSync(join(dir, 'prereg', 'FROZEN')))
		throw new Error(`prereg/FROZEN does not exist under ${dir}`);
}

// the drawn drivers in draw order, each with its frozen native checksum
export function loadFinal(path: string, options: FinalOptions = {}) {
	guardFinal(path, options);
	const dir = resolve(options.finalDir ?? FINAL_DIR);
	const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
	const { drawn } = JSON.parse(readFileSync(join(dir, 'prereg', 'draw.json'), 'utf8')) as {
		drawn: string[];
	};
	if (new Set(drawn).size !== drawn.length) throw new Error('draw.json lists a driver twice');
	const byId = new Map(manifest.projects.flatMap((p) => p.drivers).map((d) => [d.id, d]));
	const drivers = drawn.map((id) => {
		const driver = byId.get(id);
		if (!driver) throw new Error(`drawn driver ${id} is not in the manifest`);
		if (typeof driver.result?.nativeSlotsSha256 !== 'string')
			throw new Error(`${id} has no native checksum`);
		return driver;
	});
	return { memory: manifest.memory, drivers };
}

export function wasmPathOf(buildDir: string, id: string): string {
	if (!/^[\w.-]+$/.test(id) || id.includes('..')) throw new Error(`bad driver id ${id}`);
	return join(buildDir, id, 'driver.wasm');
}

export function callOf(driver: Driver, layout: Layout): RecordsCall {
	const { records, slot, arena } = driver;
	const generator = layout.arenas + records * arena;
	const keep = (list: [number, number][]) => list.filter(([a, b]) => b > a);
	const out: [number, number] = [layout.out, layout.out + records * slot];
	const arenas: [number, number] = [layout.arenas, generator];
	return {
		kind: 'records',
		entry: 'bulk',
		count: records,
		args: (from, to) => [layout.table + 16 * from, to - from, layout.out + from * slot],
		regions: keep([
			[layout.table, layout.table + 16 * records],
			[layout.heap, layout.arenas],
			arenas,
			[generator, layout.out],
			out
		]),
		writes: keep([out, arenas])
	};
}

// layout and call of a folio arm; one scratch instantiation reads __heap_base
export function planOf(bytes: Uint8Array, driver: Driver, memory: Memory) {
	const module = new WebAssembly.Module(Uint8Array.from(bytes));
	const [only, ...more] = WebAssembly.Module.imports(module);
	if (!only || more.length || only.module !== 'env' || only.name !== 'memory')
		throw new Error(`${driver.id} imports something besides env.memory`);
	const scratch = new WebAssembly.Memory({
		initial: memory.initialPages,
		maximum: memory.maximumPages
	});
	const heapBase = new WebAssembly.Instance(module, { env: { memory: scratch } }).exports
		.__heap_base as WebAssembly.Global | undefined;
	if (!heapBase) throw new Error(`${driver.id} does not export __heap_base`);
	const layout = layoutOf(driver, Number(heapBase.value));
	const pages = Math.max(memory.initialPages, Math.ceil(layout.total / PAGE));
	if (pages > memory.maximumPages)
		throw new Error(
			`${driver.id} needs ${pages} pages, over the maximum ${memory.maximumPages}`
		);
	return { layout, pages, call: callOf(driver, layout) };
}

export const certificateOf = (d: Pick<RouterDecision, 'route'>) =>
	d.route === 'summary' || d.route === 'window' ? d.route : 'none';

const decisionOf = (d: RouterDecision) => ({
	route: d.route,
	reason: d.reason,
	detail: d.detail,
	analyses: d.analyses,
	cacheHit: d.cacheHit,
	considered: d.considered
});

// #endregion

// #region order

const mulberry = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// the dev harness rotation, or a seeded shuffle when a seed is given
export function armOrder(arms: Arm[], round: number, index: number, seed?: number): Arm[] {
	if (seed === undefined) {
		const turn = (round + index) % arms.length;
		return [...arms.slice(turn), ...arms.slice(0, turn)];
	}
	const next = mulberry((seed + Math.imul(round, 1000003) + Math.imul(index, 7919)) | 0);
	const order = [...arms];
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[order[i], order[j]] = [order[j]!, order[i]!];
	}
	return order;
}

export function plannedCells(ids: string[], arms: Arm[], rounds: number, seed?: number) {
	const cells: { round: number; index: number; driver: string; arms: Arm[] }[] = [];
	for (let round = 0; round < rounds; round++)
		for (const [index, driver] of ids.entries())
			cells.push({ round, index, driver, arms: armOrder(arms, round, index, seed) });
	return cells;
}

export function dryLines(ids: string[], arms: Arm[], rounds: number, seed?: number): string[] {
	const total = ids.length * arms.length * rounds;
	return [
		`cells ${total} (${ids.length} drivers, ${arms.length} arms, ${rounds} rounds) order ${seed === undefined ? 'rotation' : 'seed ' + seed}`,
		...plannedCells(ids, arms, rounds, seed).map(
			(c) => `${c.round}\t${c.index}\t${c.driver}\t${c.arms.join(',')}`
		)
	];
}

// #endregion

// #region child: one arm in a fresh process

export interface CellArgs {
	driver: Driver;
	arm: Arm;
	session: number;
	round: number;
	workers: number;
	warm: number;
	cache?: string;
	manifest: string;
	memory: Memory;
	buildDir: string;
	final?: boolean;
	finalDir?: string;
	floors?: RouterOptions['floors'];
}

// one row: prepare, warm calls, one timed bulk call, then the output digest
export async function measure(args: CellArgs): Promise<Record<string, unknown>> {
	const { driver, arm } = args;
	if (!FINAL_ARMS.includes(arm)) throw new Error(`arm ${arm} is not a final arm`);
	guardFinal(args.manifest, args);
	const expected = driver.result?.nativeSlotsSha256;
	if (!expected) throw new Error(`${driver.id} has no native checksum`);
	const path = wasmPathOf(args.buildDir, driver.id);
	const cache = new CertificateCache();
	if (args.cache && existsSync(args.cache)) cache.load(readFileSync(args.cache, 'utf8'));
	const loadStart = loadavg();
	const opened = performance.now();
	let memory: WebAssembly.Memory;
	let layout: Layout;
	let run: () => Promise<Record<string, unknown>>;
	let close = async () => {};
	let extra: Record<string, unknown> = {};
	if (arm === 'serial') {
		memory = new WebAssembly.Memory({
			initial: args.memory.initialPages,
			maximum: args.memory.maximumPages
		});
		const loaded = await loadWasm(path, driver, { memory: args.memory } as Manifest, memory);
		layout = loaded.layout;
		run = async () => {
			loaded.bulk(0, driver.records);
			return { route: 'serial', reason: 'baseline' };
		};
	} else {
		const bytes = readFileSync(path);
		const plan = planOf(bytes, driver, args.memory);
		const router = await Router.open(bytes, plan.call, {
			mode: arm as RouterMode,
			pages: plan.pages,
			maxPages: args.memory.maximumPages,
			workers: args.workers,
			cache,
			assume: ASSUME,
			floors: args.floors
		});
		close = () => router.close();
		try {
			const prepared = performance.now();
			const used = router.exec('prepare', [
				plan.layout.table,
				driver.records,
				plan.layout.heap
			]) as number;
			if (used > driver.records * driver.recordCapacity)
				throw new Error('inputs exceed the record capacity');
			extra = {
				prepareMs: performance.now() - prepared,
				decision: decisionOf(router.decision),
				certificate: certificateOf(router.decision),
				refusal: router.decision.route === 'serial' ? router.decision.reason : undefined,
				certifyMs: router.decision.certifyMs,
				setupMs: router.setupMs
			};
		} catch (error) {
			await close();
			throw error;
		}
		memory = router.memory;
		layout = plan.layout;
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
	const size = driver.records * driver.slot;
	const clear = () => new Uint8Array(memory.buffer, layout.out, size).fill(0);
	try {
		let firstRunMs = 0;
		for (let i = 0; i < args.warm; i++) {
			clear();
			const t = performance.now();
			await run();
			if (i === 0) firstRunMs = performance.now() - t;
		}
		clear();
		const t = performance.now();
		const result = await run();
		const wallMs = performance.now() - t;
		const resourceUsage = process.resourceUsage();
		const memoryUsage = process.memoryUsage();
		const loadEnd = loadavg();
		const slots = slotDigests(
			Uint8Array.from(new Uint8Array(memory.buffer, layout.out, size)),
			driver.records,
			driver.slot
		);
		const digest = combined(slots);
		const passed = digest === expected;
		return {
			kind: 'sample',
			driver: driver.id,
			arm,
			session: args.session,
			round: args.round,
			wallMs,
			firstRunMs,
			openMs,
			...extra,
			...result,
			passed,
			digest,
			...(passed ? {} : { slots }),
			load: [loadStart[0], loadEnd[0]],
			loadStart,
			loadEnd,
			resourceUsage,
			memoryUsage,
			arch: process.arch,
			platform: process.platform,
			node: process.version
		};
	} finally {
		await close();
	}
}

// #endregion

// #region parent

const flag = (argv: string[], name: string) => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};

function spawnChild(args: CellArgs): Record<string, unknown> {
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
			driver: args.driver.id,
			arm: args.arm,
			session: args.session,
			round: args.round,
			status: result.status,
			signal: result.signal,
			stderr: result.stderr.slice(-600),
			t0,
			t1
		};
	return { ...(JSON.parse(line.slice(4)) as Record<string, unknown>), t0, t1 };
}

type Row = Sample & { digest?: string };

// rows whose combined digest differs from the serial row of the same driver and round
export function serialAgreement(rows: Row[]) {
	const serial = new Map(
		rows
			.filter((r) => r.arm === 'serial' && r.digest)
			.map((r) => [`${r.driver}\t${r.round}`, r.digest])
	);
	return rows.flatMap((r) => {
		const want = serial.get(`${r.driver}\t${r.round}`);
		return r.arm !== 'serial' && r.digest && want && r.digest !== want
			? [{ driver: r.driver, arm: r.arm, round: r.round }]
			: [];
	});
}

const readRows = (file: string) =>
	readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function parseArms(text: string | undefined): Arm[] {
	const arms = (text?.split(',') ?? [...FINAL_ARMS]) as Arm[];
	for (const arm of arms) if (!FINAL_ARMS.includes(arm)) throw new Error(`unknown arm ${arm}`);
	if (!arms.includes('serial')) arms.unshift('serial');
	return arms;
}

function pick(drivers: Driver[], only: string | undefined): Driver[] {
	if (!only) return drivers;
	const ids = only.split(',');
	for (const id of ids)
		if (!drivers.some((d) => d.id === id)) throw new Error(`${id} is not a drawn driver`);
	return drivers.filter((d) => ids.includes(d.id));
}

async function runCommand(rest: string[]) {
	const [manifest, output] = rest;
	if (!manifest || !output) throw new Error('usage: run MANIFEST OUT.jsonl --final');
	const final = rest.includes('--final');
	const loaded = loadFinal(manifest, { final });
	const drivers = pick(loaded.drivers, flag(rest, '--drivers'));
	const rounds = Number(flag(rest, '--rounds') ?? 10);
	const workers = Number(flag(rest, '--workers') ?? 8);
	const warm = Number(flag(rest, '--warm') ?? 6);
	const session = Number(flag(rest, '--session') ?? 0);
	const seedText = flag(rest, '--seed');
	const seed = seedText === undefined ? undefined : Number(seedText);
	const arms = parseArms(flag(rest, '--modes'));
	if (rest.includes('--dry')) {
		console.log(
			dryLines(
				drivers.map((d) => d.id),
				arms,
				rounds,
				seed
			).join('\n')
		);
		return;
	}
	const floorsText = flag(rest, '--floors');
	const floors = floorsText ? (JSON.parse(floorsText) as RouterOptions['floors']) : undefined;
	const buildDir = resolve(flag(rest, '--build') ?? BUILD_DIR);
	const cache = flag(rest, '--cache');
	const resume = rest.includes('--resume') && existsSync(output);
	const done = new Set<string>();
	if (resume) {
		for (const r of readRows(output))
			if (r.kind === 'sample') done.add(`${r.driver}\t${r.arm}\t${r.round}`);
	} else writeFileSync(output, '', { flag: 'wx' });
	appendFileSync(
		output,
		JSON.stringify({
			kind: 'run',
			started: new Date().toISOString(),
			resumed: resume,
			session,
			rounds,
			workers,
			warm,
			seed,
			arms,
			drivers: drivers.map((d) => d.id),
			adapterSha256: sha(readFileSync(here)),
			manifestSha256: sha(readFileSync(manifest)),
			routerVersion: ROUTER_VERSION,
			routerConstants,
			floors,
			node: process.version,
			arch: process.arch,
			platform: process.platform
		}) + '\n'
	);
	for (const cell of plannedCells(
		drivers.map((d) => d.id),
		arms,
		rounds,
		seed
	))
		for (const arm of cell.arms) {
			if (done.has(`${cell.driver}\t${arm}\t${cell.round}`)) continue;
			const row = spawnChild({
				driver: drivers[cell.index]!,
				arm,
				session,
				round: cell.round,
				workers,
				warm,
				cache,
				manifest,
				memory: loaded.memory,
				buildDir,
				final,
				floors
			});
			appendFileSync(output, JSON.stringify(row) + '\n');
			if (row.kind === 'sample' && !row.passed)
				console.error(`WRONG OUTPUT ${cell.driver} ${arm} round ${cell.round}`);
			if (row.kind === 'error')
				console.error(`ERROR ${cell.driver} ${arm} round ${cell.round}`);
		}
	const rows = readRows(output).filter((r) => r.kind === 'sample') as unknown as Row[];
	const mismatches = serialAgreement(rows);
	for (const m of mismatches)
		console.error(`SERIAL MISMATCH ${m.driver} ${m.arm} round ${m.round}`);
	appendFileSync(
		output,
		JSON.stringify({
			kind: 'check',
			rows: rows.length,
			wrong: rows.filter((r) => !r.passed).length,
			serialMismatches: mismatches
		}) + '\n'
	);
	console.log('done', output, JSON.stringify(routerConstants));
}

// #endregion

// #region certify

// certificate or refusal per mode, then one pass over a persistent cache
export function certifyDriver(
	bytes: Uint8Array,
	driver: Driver,
	memory: Memory,
	persistent: CertificateCache,
	reps: number
) {
	const plan = planOf(bytes, driver, memory);
	const moduleSha256 = sha(bytes);
	const rows: Record<string, unknown>[] = [];
	const note = (mode: RouterMode, rep: number | undefined, options: Partial<RouterOptions>) => {
		const result = decide(bytes, plan.call, {
			mode,
			pages: plan.pages,
			workers: 8,
			cache: new CertificateCache(),
			...options
		}).decision;
		rows.push({
			kind: 'certify',
			driver: driver.id,
			moduleSha256,
			mode,
			rep,
			persistent: options.cache !== undefined,
			certifyMs: result.certifyMs,
			cacheHit: result.cacheHit,
			route: result.route,
			reason: result.reason,
			detail: result.detail,
			certificate: certificateOf(result),
			refusal: result.route === 'serial' ? result.reason : undefined,
			analyses: result.analyses
		});
	};
	for (let rep = 0; rep < reps; rep++)
		for (const mode of (rep % 2
			? ['shared', 'independent']
			: ['independent', 'shared']) as RouterMode[])
			note(mode, rep, {});
	note('router', undefined, { cache: persistent, assume: ASSUME });
	return rows;
}

async function certifyCommand(rest: string[]) {
	const [manifest, cachePath, outFile] = rest;
	if (!manifest || !cachePath || !outFile)
		throw new Error('usage: certify MANIFEST CACHE.json OUT.jsonl --final');
	const loaded = loadFinal(manifest, { final: rest.includes('--final') });
	const buildDir = resolve(flag(rest, '--build') ?? BUILD_DIR);
	const reps = Number(flag(rest, '--reps') ?? 3);
	const persistent = new CertificateCache();
	if (existsSync(cachePath)) persistent.load(readFileSync(cachePath, 'utf8'));
	for (const driver of pick(loaded.drivers, flag(rest, '--drivers'))) {
		const bytes = readFileSync(wasmPathOf(buildDir, driver.id));
		for (const row of certifyDriver(bytes, driver, loaded.memory, persistent, reps))
			appendFileSync(outFile, JSON.stringify(row) + '\n');
		writeFileSync(cachePath, persistent.serialize());
	}
}

// #endregion

// #region summary

function summaryCommand(rest: string[]) {
	const rows = readRows(rest[0]!).filter((r) => r.kind === 'sample') as unknown as Sample[];
	const arms = FINAL_ARMS.filter((arm) => rows.some((r) => r.arm === arm));
	const result = summarize(rows, arms);
	const lines: string[] = [];
	for (const arm of arms) {
		lines.push(`## ${arm}`);
		for (const r of result.rows[arm]!)
			lines.push(
				`${r.driver.padEnd(40)} ${r.route.padEnd(8)} ${r.reason.padEnd(24)} serial ${r.serialMs.toFixed(3)} ms  ${r.speedup.median.toFixed(3)} (${r.speedup.min.toFixed(3)} to ${r.speedup.max.toFixed(3)}; ci ${r.speedup.lo.toFixed(3)} to ${r.speedup.hi.toFixed(3)})${r.wrong ? ' WRONG ' + r.wrong : ''}`
			);
		const t = result.totals[arm]!;
		const min = Math.min(...result.rows[arm]!.map((r) => r.speedup.median));
		lines.push(
			`geomean ${t.geomean.toFixed(3)} min ${min.toFixed(3)} p10 ${t.p10.toFixed(3)} slowest ${t.slowest.join(', ')}`
		);
	}
	lines.push(`wrong outputs: ${result.wrong.length}`);
	console.log(lines.join('\n'));
	const out = flag(rest, '--json');
	if (out) writeFileSync(out, JSON.stringify(result, null, '\t') + '\n');
}

// #endregion

export async function main(argv: string[]) {
	const [command, ...rest] = argv;
	if (command === 'child') {
		console.log('ROW ' + JSON.stringify(await measure(JSON.parse(rest[0]!))));
		return;
	}
	if (command === 'run') return runCommand(rest);
	if (command === 'certify') return certifyCommand(rest);
	if (command === 'summary') return summaryCommand(rest);
	throw new Error('usage: router-ablation-final.ts run|certify|summary');
}

if (import.meta.main) await main(process.argv.slice(2));
