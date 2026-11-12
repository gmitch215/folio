import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { certifyOwnership } from '../../src/ownership.ts';
import { Router, type RecordsCall, type RouterMode, type RouterOptions } from '../../src/router.ts';
import { ARENAS, DATA, OUT, RECORDS, SLICE, STACK_TOP, TABLE } from './ownership-alloc-modules.ts';
import { image, layout, recordsOwnOf, type Row } from './ownership-redteam-run.ts';
import { build, plan } from './ownership-redteam.ts';
import { importsUrl } from './ownership-slices-rig.ts';

// usage: ownership-redteam-router.ts run MAIN.jsonl OUT.jsonl   cases from a generator run
//        ownership-redteam-router.ts summary OUT.jsonl
// every case opens a router in one mode over a generated module, runs the records call and compares the
// whole memory (minus the stack zone) with the serial run of the same module

export const MODES: RouterMode[] = ['serial', 'w1', 'w2', 'independent', 'shared', 'router'];
export type Variant =
	| 'standard'
	| 'writes-empty'
	| 'writes-arena'
	| 'writes-out'
	| 'writes-shifted'
	| 'regions-shifted'
	| 'shared-memory'
	| 'overlap-window'
	| 'overlap-regions';

const REGIONS: [number, number][] = [
	[TABLE, TABLE + 16 * RECORDS],
	[DATA, DATA + 320 * RECORDS],
	[OUT, OUT + 64 * RECORDS],
	[ARENAS, ARENAS + SLICE * RECORDS]
];
const WRITES: [number, number][] = [
	[OUT, OUT + 64 * RECORDS],
	[ARENAS, ARENAS + SLICE * RECORDS]
];

function callFor(variant: Variant): RecordsCall {
	const base: RecordsCall = {
		kind: 'records',
		entry: 'bulk',
		count: RECORDS,
		args: (from, to) => [TABLE + 16 * from, to - from, OUT + 64 * from],
		regions: REGIONS,
		writes: WRITES
	};
	if (variant === 'writes-empty') return { ...base, writes: [] };
	if (variant === 'writes-arena') return { ...base, writes: [WRITES[1]!] };
	if (variant === 'writes-out') return { ...base, writes: [WRITES[0]!] };
	if (variant === 'writes-shifted')
		return { ...base, writes: WRITES.map(([a, b]) => [a + 64, b + 64] as [number, number]) };
	if (variant === 'regions-shifted')
		return { ...base, regions: REGIONS.map(([a, b]) => [a + 8, b + 8] as [number, number]) };
	if (variant === 'overlap-window') return { ...base, regions: [...REGIONS, [4096, 4352]] };
	if (variant === 'overlap-regions')
		return {
			...base,
			regions: [...REGIONS, [OUT + 32, OUT + 640]],
			writes: [[OUT + 8, OUT + 600]]
		};
	return base;
}

export interface RouterRow {
	seed: number;
	mode: RouterMode;
	variant: Variant;
	layoutSeed: number;
	certVerdict?: string;
	route?: string;
	reason?: string;
	detail?: string;
	threw?: boolean;
	serialTrap?: boolean;
	equal?: boolean;
	why?: string;
	verdict: 'equal' | 'inherited' | 'premise' | 'ROUTER-FALSE' | 'timeout' | 'error';
}

const inStack = (at: number) => at >= STACK_TOP - 4096 && at < STACK_TOP;

export async function routerCase(
	seed: number,
	mode: RouterMode,
	variant: Variant,
	layoutSeed: number,
	certVerdict: string | undefined
): Promise<RouterRow> {
	const row: RouterRow = { seed, mode, variant, layoutSeed, certVerdict, verdict: 'equal' };
	const shared = variant === 'shared-memory';
	const bytes = build(plan(seed), shared);
	const module = new WebAssembly.Module(Uint8Array.from(bytes));
	const reference = (() => {
		const memory = new WebAssembly.Memory({ initial: 8, maximum: 8, shared });
		new Uint8Array(memory.buffer).set(image(layoutSeed));
		const instance = new WebAssembly.Instance(module, { env: { memory, f: () => {} } });
		let trapped = false;
		try {
			(instance.exports.bulk as (...a: number[]) => void)(TABLE, RECORDS, OUT);
		} catch {
			trapped = true;
		}
		return { trapped, bytes: new Uint8Array(memory.buffer).slice() };
	})();
	row.serialTrap = reference.trapped;
	const options: RouterOptions = {
		mode,
		pages: 8,
		maxPages: 40,
		workers: 4,
		imports: importsUrl.href,
		floors: { windowFloorMs: 0, trackedFloorMs: 0 },
		assume:
			mode === 'router' ? { importsDeterministic: true, residueUnobserved: true } : undefined
	};
	let router: Router;
	try {
		router = await Router.open(bytes, callFor(variant), options);
	} catch (error) {
		row.verdict = 'error';
		row.why = 'open: ' + String((error as Error).message ?? error).slice(0, 120);
		return row;
	}
	try {
		layout(
			new Uint8Array(router.memory.buffer),
			new Uint32Array(router.memory.buffer),
			layoutSeed
		);
		let threw = false;
		let run;
		try {
			run = await router.run();
		} catch {
			threw = true;
		}
		row.threw = threw;
		row.route = run?.route ?? router.route;
		row.reason = run?.reason ?? router.decision.reason;
		row.detail = router.decision.detail.slice(0, 160);
		const got = new Uint8Array(router.memory.buffer).slice(0, 8 * 65536);
		let at = -1;
		for (let i = 0; i < got.length; i++)
			if (got[i] !== reference.bytes[i] && !inStack(i)) {
				at = i;
				break;
			}
		row.equal = at === -1 && threw === reference.trapped;
		if (row.equal) return row;
		row.why = at === -1 ? `trap ${reference.trapped} against ${threw}` : `byte ${at}`;
		if (row.route === 'serial' && !threw) {
			row.verdict = 'ROUTER-FALSE';
			row.why += ' on the serial route';
			return row;
		}
		const cert = certifyOwnership(bytes);
		const windows = cert.kind === 'certificate' ? cert.windows : [];
		const own = recordsOwnOf(bytes, layoutSeed, windows);
		if (certVerdict === 'false') row.verdict = 'inherited';
		else if (!own.ok || certVerdict === 'premise') row.verdict = 'premise';
		else row.verdict = 'ROUTER-FALSE';
		return row;
	} catch (error) {
		row.verdict = 'error';
		row.why = String((error as Error).message ?? error).slice(0, 160);
		return row;
	} finally {
		await router.close();
	}
}

// #region case list

export interface Case {
	seed: number;
	mode: RouterMode;
	variant: Variant;
	layoutSeed: number;
	certVerdict?: string;
}

export function cases(main: Row[]): Case[] {
	const out: Case[] = [];
	const accepted = main.filter((r) => r.outcome === 'certificate');
	const ok = accepted.filter((r) => r.verdict === 'ok');
	const bad = accepted.filter((r) => r.verdict !== 'ok');
	const refused = main.filter((r) => r.outcome !== 'certificate' && r.outcome !== 'invalid');
	const every = <T>(l: T[], n: number) =>
		l.filter((_, i) => i % Math.max(1, Math.floor(l.length / n)) === 0).slice(0, n);
	const layoutOf = (i: number) => (i % 2 === 0 ? 3 : 1);
	every(ok, 60).forEach((r, i) => {
		for (const mode of MODES)
			out.push({
				seed: r.seed,
				mode,
				variant: 'standard',
				layoutSeed: layoutOf(i),
				certVerdict: r.verdict
			});
	});
	bad.slice(0, 40).forEach((r, i) => {
		for (const mode of ['w2', 'independent', 'router'] as RouterMode[])
			out.push({
				seed: r.seed,
				mode,
				variant: 'standard',
				layoutSeed: layoutOf(i),
				certVerdict: r.verdict
			});
	});
	const noWindow = refused.filter((r) => r.outcome === 'no-window');
	every(noWindow, 20).forEach((r, i) => {
		for (const mode of ['w2', 'router'] as RouterMode[])
			out.push({ seed: r.seed, mode, variant: 'standard', layoutSeed: layoutOf(i) });
	});
	every(
		refused.filter((r) => r.outcome !== 'no-window'),
		40
	).forEach((r, i) => {
		for (const mode of ['shared', 'router'] as RouterMode[])
			out.push({ seed: r.seed, mode, variant: 'standard', layoutSeed: layoutOf(i) });
	});
	every(ok, 30).forEach((r, i) => {
		for (const variant of [
			'writes-empty',
			'writes-arena',
			'overlap-window',
			'overlap-regions'
		] as Variant[])
			for (const mode of ['w2', 'router'] as RouterMode[])
				out.push({
					seed: r.seed,
					mode,
					variant,
					layoutSeed: layoutOf(i),
					certVerdict: r.verdict
				});
	});
	every(ok, 20).forEach((r, i) => {
		for (const variant of ['writes-out', 'writes-shifted', 'regions-shifted'] as Variant[])
			for (const mode of ['w2', 'router'] as RouterMode[])
				out.push({
					seed: r.seed,
					mode,
					variant,
					layoutSeed: layoutOf(i),
					certVerdict: r.verdict
				});
	});
	every(noWindow, 30).forEach((r, i) => {
		out.push({
			seed: r.seed,
			mode: 'router',
			variant: 'shared-memory',
			layoutSeed: layoutOf(i)
		});
	});
	every(ok, 20).forEach((r, i) => {
		for (const mode of ['w2', 'router'] as RouterMode[])
			out.push({
				seed: r.seed,
				mode,
				variant: 'shared-memory',
				layoutSeed: layoutOf(i),
				certVerdict: r.verdict
			});
	});
	return out;
}

// #endregion

// #region runner

async function chunk(file: string, from: number, to: number, out: string) {
	const main = readFileSync(file, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Row);
	const list = cases(main);
	for (let i = from; i < Math.min(to, list.length); i++) {
		const c = list[i]!;
		const row = await Promise.race([
			routerCase(c.seed, c.mode, c.variant, c.layoutSeed, c.certVerdict),
			new Promise<RouterRow>((resolve) =>
				setTimeout(
					() =>
						resolve({
							...c,
							verdict: 'timeout',
							why: 'router case over 90 s'
						} as RouterRow),
					90000
				)
			)
		]);
		appendFileSync(out, JSON.stringify({ index: i, ...row }) + '\n');
		if (row.verdict === 'timeout') process.exit(3);
	}
}

function watch(file: string, from: number, to: number, out: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[new URL(import.meta.url).pathname, 'chunk', file, String(from), String(to), out],
			{ stdio: ['ignore', 'ignore', 'inherit'] }
		);
		let size = statSync(out).size;
		let idle = 0;
		const timer = setInterval(() => {
			const now = statSync(out).size;
			idle = now === size ? idle + 5 : 0;
			size = now;
			if (idle >= 150) child.kill('SIGKILL');
		}, 5000);
		child.on('exit', (code) => {
			clearInterval(timer);
			resolve(code ?? 1);
		});
	});
}

async function run(file: string, out: string) {
	const main = readFileSync(file, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Row);
	const total = cases(main).length;
	if (!existsSync(out)) writeFileSync(out, '');
	let at = 0;
	while (at < total) {
		const to = Math.min(total, at + 60);
		const code = await watch(file, at, to, out);
		if (code === 0) {
			at = to;
			continue;
		}
		const rows = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean);
		const last = rows.length
			? (JSON.parse(rows[rows.length - 1]!) as { index: number }).index
			: at - 1;
		const hung = Math.max(at, last + 1);
		const timeout =
			rows.length && (JSON.parse(rows[rows.length - 1]!) as RouterRow).verdict === 'timeout';
		if (!timeout)
			appendFileSync(
				out,
				JSON.stringify({ index: hung, verdict: 'timeout', why: 'killed, no progress' }) +
					'\n'
			);
		at = hung + (timeout ? 0 : 1);
		if (timeout) at = last + 1;
	}
	console.log('cases', total);
}

function summary(out: string) {
	const rows = readFileSync(out, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as RouterRow);
	const tally = (f: (r: RouterRow) => string) => {
		const m = new Map<string, number>();
		for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
		return [...m].sort((a, b) => b[1] - a[1]);
	};
	console.log(JSON.stringify({ cases: rows.length, verdicts: tally((r) => r.verdict) }));
	console.log(
		'by mode and route',
		JSON.stringify(tally((r) => `${r.mode}:${r.route}:${r.reason}`))
	);
	console.log('by variant', JSON.stringify(tally((r) => `${r.variant}:${r.verdict}`)));
	for (const r of rows.filter(
		(r) =>
			r.verdict === 'ROUTER-FALSE' ||
			r.verdict === 'inherited' ||
			r.verdict === 'timeout' ||
			r.verdict === 'error'
	))
		console.log(r.verdict, r.seed, r.mode, r.variant, r.route, r.reason, r.why);
}

// #endregion

const [command, a, b, c, d] = process.argv.slice(2);
if (!import.meta.main) void 0;
else if (command === 'run') await run(a!, b!);
else if (command === 'chunk') await chunk(a!, Number(b), Number(c), d!);
else if (command === 'summary') summary(a!);
