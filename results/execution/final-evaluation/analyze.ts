import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { geomean, interval, median } from '../../../../scripts/research/router-ablation.ts';

// usage:
//   analyze.ts CONFIG.json OUT_PREFIX      writes OUT_PREFIX.json and OUT_PREFIX.md
//   analyze.ts --selftest                  runs the script on a small made-up input and checks known values
// config: { manifest, archs: { NAME: { host: 'rig' | 'mac', correct?, certify?, sessions: [{ label, rows, sampler? }] } } }
// prereg: gate 1 geomean >= 1.20, gate 2 each of the slowest ceil(0.1 n) >= 0.90, gate 3 zero wrong outputs

const FOLIO = ['w1', 'w2', 'independent', 'shared', 'router'];
const ARMS = ['serial', ...FOLIO];
const LINE1 = 1.2;
const LINE2 = 0.9;
const SEED = 12345;
const RESAMPLES = 10000;

type Row = Record<string, any>;

interface SessionConfig {
	label: string;
	rows: string;
	sampler?: string;
}

interface ArchConfig {
	host: 'rig' | 'mac';
	correct?: string;
	certify?: string;
	sessions: SessionConfig[];
}

interface Config {
	manifest: string;
	archs: Record<string, ArchConfig>;
}

const readRows = (file: string): Row[] =>
	existsSync(file)
		? readFileSync(file, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Row)
		: [];

const mulberry = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'NA');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'NA');
const countBy = (items: string[]) => {
	const out: Record<string, number> = {};
	for (const i of items) out[i] = (out[i] ?? 0) + 1;
	return out;
};
const modeOf = (items: string[]) =>
	Object.entries(countBy(items)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
	'-';
const describe = (counts: Record<string, number>) =>
	Object.entries(counts)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([k, n]) => `${k} ${n}`)
		.join(', ');

// #region statistics

export function bootstrap(values: number[], stat: (v: number[]) => number) {
	const next = mulberry(SEED);
	const n = values.length;
	const draws = Array.from({ length: RESAMPLES }, () =>
		stat(Array.from({ length: n }, () => values[Math.floor(next() * n)]!))
	).sort((a, b) => a - b);
	return { lo: draws[Math.floor(0.025 * RESAMPLES)]!, hi: draws[Math.floor(0.975 * RESAMPLES) - 1]!, draws };
}

const kth = (values: number[], k: number) => [...values].sort((a, b) => a - b)[k - 1]!;

export interface Gates {
	n: number;
	missing: string[];
	geomean: number;
	slowestCount: number;
	slowest: { driver: string; speedup: number }[];
	min: number;
	p10: number;
	gate1: boolean;
	gate2: boolean;
	boot: {
		geomeanMedian: number;
		geomeanLo: number;
		geomeanHi: number;
		pGeomean: number;
		minLo: number;
		minHi: number;
		pMin: number;
		p10Lo: number;
		p10Hi: number;
		pP10: number;
	};
}

// gate 1 and 2 over per-driver median speedups; a driver with no measured ratio makes the gate NOT MET
export function gatesOf(speeds: { driver: string; speedup: number }[], expected: string[]): Gates {
	const have = new Set(speeds.map((s) => s.driver));
	const missing = expected.filter((d) => !have.has(d));
	const values = speeds.map((s) => s.speedup);
	const k = Math.max(1, Math.ceil(0.1 * expected.length));
	const sorted = [...speeds].sort((a, b) => a.speedup - b.speedup);
	const gm = geomean(values);
	const min = sorted[0]!.speedup;
	const kk = Math.max(1, Math.ceil(0.1 * values.length));
	const g = bootstrap(values, geomean);
	const m = bootstrap(values, (v) => Math.min(...v));
	const p = bootstrap(values, (v) => kth(v, kk));
	const frac = (d: number[], f: (x: number) => boolean) => d.filter(f).length / d.length;
	return {
		n: speeds.length,
		missing,
		geomean: gm,
		slowestCount: k,
		slowest: sorted.slice(0, k),
		min,
		p10: kth(values, kk),
		gate1: missing.length === 0 && gm >= LINE1,
		gate2: missing.length === 0 && min >= LINE2,
		boot: {
			geomeanMedian: median(g.draws),
			geomeanLo: g.lo,
			geomeanHi: g.hi,
			pGeomean: frac(g.draws, (x) => x >= LINE1),
			minLo: m.lo,
			minHi: m.hi,
			pMin: frac(m.draws, (x) => x >= LINE2),
			p10Lo: p.lo,
			p10Hi: p.hi,
			pP10: frac(p.draws, (x) => x >= LINE2)
		}
	};
}

// #endregion

// #region rows

const samplesOf = (rows: Row[]) => rows.filter((r) => r.kind === 'sample');

// paired ratios serial over arm, by round; key is session label and round
export function ratiosOf(samples: Row[], driver: string, arm: string, tag = '') {
	const serial = new Map<number, number>();
	for (const s of samples)
		if (s.driver === driver && s.arm === 'serial') serial.set(s.round, s.wallMs);
	const out: { key: string; ratio: number }[] = [];
	for (const s of samples)
		if (s.driver === driver && s.arm === arm && serial.has(s.round))
			out.push({ key: `${tag}:${s.round}`, ratio: serial.get(s.round)! / s.wallMs });
	return out;
}

export interface DriverStat {
	driver: string;
	project: string;
	speedup: number;
	n: number;
	lo: number;
	hi: number;
	min: number;
	max: number;
	serialMs: number;
	armMs: number;
}

export function tableOf(
	samples: Row[],
	arm: string,
	drivers: string[],
	projectOf: (d: string) => string,
	tags: (s: Row) => string = () => ''
): DriverStat[] {
	const out: DriverStat[] = [];
	for (const driver of drivers) {
		const ratios: number[] = [];
		const serialMs: number[] = [];
		const armMs: number[] = [];
		const by = new Map<string, Row[]>();
		for (const s of samples) {
			const t = tags(s);
			by.set(t, [...(by.get(t) ?? []), s]);
		}
		for (const [tag, part] of by) {
			for (const r of ratiosOf(part, driver, arm, tag)) ratios.push(r.ratio);
		}
		for (const s of samples) {
			if (s.driver !== driver) continue;
			if (s.arm === 'serial') serialMs.push(s.wallMs);
			if (s.arm === arm) armMs.push(s.wallMs);
		}
		if (!ratios.length) continue;
		const iv = interval(ratios);
		out.push({
			driver,
			project: projectOf(driver),
			speedup: iv.median,
			n: iv.n,
			lo: iv.lo,
			hi: iv.hi,
			min: iv.min,
			max: iv.max,
			serialMs: median(serialMs),
			armMs: median(armMs)
		});
	}
	return out;
}

// rows whose time is over 50 times the median of the same driver and arm in the same group
export function overMedian(samples: Row[], group: (s: Row) => string = () => '') {
	const by = new Map<string, number[]>();
	for (const s of samples) {
		const key = `${group(s)}\t${s.driver}\t${s.arm}`;
		by.set(key, [...(by.get(key) ?? []), s.wallMs]);
	}
	return samples.filter((s) => s.wallMs > 50 * median(by.get(`${group(s)}\t${s.driver}\t${s.arm}`)!));
}

// #endregion

// #region contamination

interface RigTick {
	t: number;
	load: number;
	busy: number;
	containers: { name: string; cpu: number }[];
}

export function parseRigSampler(file: string): RigTick[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => {
			const [t, load, busy, rest = ''] = l.split('\t');
			return {
				t: Number(t),
				load: Number(load),
				busy: Number(busy),
				containers: [...rest.matchAll(/(\S+?):([\d.]+)%:/g)].map((m) => ({
					name: m[1]!,
					cpu: Number(m[2])
				}))
			};
		});
}

interface MacTick {
	t: number;
	load: number;
	top: { cpu: number; name: string }[];
}

export function parseMacSampler(file: string): MacTick[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => {
			const [t, load, rest = ''] = l.split('\t');
			return {
				t: Number(t),
				load: Number(load),
				top: rest
					.trim()
					.split(' ')
					.filter(Boolean)
					.map((p) => ({ cpu: Number(p.split(':')[0]), name: p.split(':').slice(1).join(':') }))
			};
		});
}

const MINE = 'rig-w4-final-';
const NCPU = 24;

// why a sample is flagged, from the sampler ticks around [t0, t1]; the empty list means clean
export function rigFlags(row: Row, ticks: RigTick[], lockTimes: number[] = []): string[] {
	const within = ticks.filter((k) => k.t >= row.t0 - 1 && k.t <= row.t1 + 1);
	const flags: string[] = [];
	if (within.some((k) => k.containers.some((c) => !c.name.startsWith(MINE) && c.cpu > 10)))
		flags.push('other-container');
	if (
		within.some((k) => {
			const mine = sum(k.containers.filter((c) => c.name.startsWith(MINE)).map((c) => c.cpu));
			return k.busy - mine / NCPU > 25;
		})
	)
		flags.push('host-busy');
	if (lockTimes.some((t) => t >= row.t0 - 1 && t <= row.t1 + 1)) flags.push('net-lock');
	return flags;
}

export function macFlags(row: Row, ticks: MacTick[]): string[] {
	const within = ticks.filter((k) => k.t >= row.t0 - 1 && k.t <= row.t1 + 1);
	const loads = [row.loadStart?.[0], row.loadEnd?.[0], ...within.map((k) => k.load)].filter(
		(x): x is number => typeof x === 'number'
	);
	return loads.some((x) => x >= 12) ? ['load-12'] : [];
}

// #endregion

// #region per session

export interface SessionResult {
	label: string;
	rows: number;
	samples: number;
	errors: Row[];
	wrong: { driver: string; arm: string; round: number }[];
	serialMismatches: number;
	flagged: number;
	flagReasons: Record<string, number>;
	over50: { driver: string; arm: string; round: number; wallMs: number }[];
	sampler: Record<string, unknown>;
	arms: Record<string, { table: DriverStat[]; gates: Gates }>;
	routerWithout50: { geomean: number; min: number } | undefined;
	timeSpan: [string, string] | undefined;
}

export function analyzeSession(
	cfg: SessionConfig,
	host: 'rig' | 'mac',
	drivers: string[],
	projectOf: (d: string) => string
): SessionResult {
	const rows = readRows(cfg.rows);
	const samples = samplesOf(rows);
	const errors = rows.filter((r) => r.kind === 'error');
	const ticksRig = host === 'rig' && cfg.sampler ? parseRigSampler(cfg.sampler) : [];
	const ticksMac = host === 'mac' && cfg.sampler ? parseMacSampler(cfg.sampler) : [];
	const lockFile = cfg.sampler?.replace(/\.sampler\.tsv$/, '.lock.txt');
	const lockTimes =
		lockFile && existsSync(lockFile)
			? readFileSync(lockFile, 'utf8')
					.split('\n')
					.filter(Boolean)
					.map(Number)
			: [];
	const reasons: string[] = [];
	let flagged = 0;
	for (const s of samples) {
		const f = host === 'rig' ? rigFlags(s, ticksRig, lockTimes) : macFlags(s, ticksMac);
		s.flags = f;
		if (f.length) flagged++;
		reasons.push(...f);
	}
	const over = overMedian(samples);
	const arms: SessionResult['arms'] = {};
	for (const arm of FOLIO) {
		const table = tableOf(samples, arm, drivers, projectOf);
		if (table.length) arms[arm] = { table, gates: gatesOf(table.map((t) => ({ driver: t.driver, speedup: t.speedup })), drivers) };
	}
	let routerWithout50: SessionResult['routerWithout50'];
	if (over.length && arms.router) {
		const bad = new Set(over.map((s) => `${s.driver}\t${s.arm}\t${s.round}`));
		const keep = samples.filter((s) => !bad.has(`${s.driver}\t${s.arm}\t${s.round}`));
		const table = tableOf(keep, 'router', drivers, projectOf);
		routerWithout50 = {
			geomean: geomean(table.map((t) => t.speedup)),
			min: Math.min(...table.map((t) => t.speedup))
		};
	}
	const times = rows.filter((r) => typeof r.t0 === 'number').map((r) => r.t0 as number);
	const loads: Record<string, unknown> = {};
	if (ticksRig.length) {
		loads.ticks = ticksRig.length;
		loads.loadMax = Math.max(...ticksRig.map((k) => k.load));
		loads.busyMax = Math.max(...ticksRig.map((k) => k.busy));
		const names = new Set(ticksRig.flatMap((k) => k.containers.map((c) => c.name)));
		loads.otherAbove10 = [...names].filter(
			(n) =>
				!n.startsWith(MINE) &&
				ticksRig.some((k) => k.containers.some((c) => c.name === n && c.cpu > 10))
		);
		loads.lockTicks = lockTimes.length;
	}
	if (ticksMac.length) {
		loads.ticks = ticksMac.length;
		loads.loadMax = Math.max(...ticksMac.map((k) => k.load));
		loads.loadMedian = median(ticksMac.map((k) => k.load));
		const nonLane = (k: MacTick) =>
			Math.max(0, ...k.top.filter((p) => !/(^|\/)node$/.test(p.name)).map((p) => p.cpu));
		loads.nonLaneMaxCpu = Math.max(...ticksMac.map(nonLane));
		loads.nonLaneStartEnd = [nonLane(ticksMac[0]!), nonLane(ticksMac[ticksMac.length - 1]!)];
		const quiet =
			(loads.loadMax as number) < 6 && (loads.nonLaneStartEnd as number[]).every((c) => c <= 25);
		loads.label = quiet ? 'quiet' : 'loaded';
	}
	if (host === 'rig' && ticksRig.length)
		loads.label = flagged === 0 ? 'quiet' : 'contaminated';
	return {
		label: cfg.label,
		rows: rows.length,
		samples: samples.length,
		errors,
		wrong: samples
			.filter((s) => !s.passed)
			.map((s) => ({ driver: s.driver, arm: s.arm, round: s.round })),
		serialMismatches: rows
			.filter((r) => r.kind === 'check')
			.reduce((n, r) => n + (r.serialMismatches?.length ?? 0), 0),
		flagged,
		flagReasons: countBy(reasons),
		over50: over.map((s) => ({ driver: s.driver, arm: s.arm, round: s.round, wallMs: s.wallMs })),
		sampler: loads,
		arms,
		routerWithout50,
		timeSpan: times.length
			? [new Date(Math.min(...times) * 1000).toISOString(), new Date(Math.max(...times) * 1000).toISOString()]
			: undefined
	};
}

// #endregion

// #region pooled and routes

export function pooled(
	sessions: { label: string; samples: Row[] }[],
	arm: string,
	drivers: string[],
	projectOf: (d: string) => string
) {
	const all = sessions.flatMap((s) => s.samples.map((r) => ({ ...r, tag: s.label })));
	const table = tableOf(all, arm, drivers, projectOf, (r) => r.tag);
	return { table, gates: gatesOf(table.map((t) => ({ driver: t.driver, speedup: t.speedup })), drivers) };
}

// W3 readings: without the top one and two drivers, and per project
export function w3Readings(table: DriverStat[]) {
	const sorted = [...table].sort((a, b) => b.speedup - a.speedup);
	const gm = (rows: DriverStat[]) => geomean(rows.map((r) => r.speedup));
	const projects = [...new Set(table.map((t) => t.project))].sort();
	return {
		all: gm(table),
		without1: { dropped: sorted.slice(0, 1).map((r) => r.driver), geomean: gm(sorted.slice(1)) },
		without2: { dropped: sorted.slice(0, 2).map((r) => r.driver), geomean: gm(sorted.slice(2)) },
		projects: projects.map((p) => {
			const part = table.filter((t) => t.project === p);
			return { project: p, drivers: part.length, geomean: gm(part), min: Math.min(...part.map((r) => r.speedup)) };
		})
	};
}

export function routesOf(samples: Row[], drivers: string[]) {
	const perArm: Record<string, any> = {};
	for (const arm of ARMS) {
		const mine = samples.filter((s) => s.arm === arm);
		if (!mine.length) continue;
		const perDriver = drivers.map((d) => {
			const part = mine.filter((s) => s.driver === d);
			return {
				driver: d,
				rows: part.length,
				routes: countBy(part.map((s) => s.route ?? '-')),
				reasons: countBy(part.map((s) => s.reason ?? '-')),
				certificate: modeOf(part.map((s) => s.certificate ?? '-')),
				refusal: modeOf(part.map((s) => s.refusal ?? '-')),
				dispatched: part.filter((s) => s.dispatched).length
			};
		});
		perArm[arm] = {
			rows: mine.length,
			routes: countBy(mine.map((s) => s.route ?? '-')),
			reasons: countBy(mine.map((s) => s.reason ?? '-')),
			modalRouteDrivers: countBy(perDriver.map((p) => modeOf(Object.entries(p.routes).flatMap(([k, n]) => Array<string>(n).fill(k))))),
			certificateDrivers: countBy(perDriver.map((p) => p.certificate)),
			refusalReasons: countBy(perDriver.filter((p) => p.refusal !== '-').map((p) => p.refusal)),
			cost: Object.fromEntries(
				['certifyMs', 'setupMs', 'openMs', 'prepareMs', 'firstRunMs', 'probeMs'].map((f) => {
					const v = mine.map((s) => s[f]).filter((x): x is number => typeof x === 'number');
					return [f, v.length ? median(v) : null];
				})
			),
			perDriver
		};
	}
	return perArm;
}

export function certifySummary(rows: Row[]) {
	const certify = rows.filter((r) => r.kind === 'certify');
	if (!certify.length) return undefined;
	const modes = [...new Set(certify.map((r) => r.mode as string))];
	const out: Record<string, any> = {};
	for (const mode of modes) {
		const mine = certify.filter((r) => r.mode === mode && !r.persistent);
		const persistent = certify.filter((r) => r.mode === mode && r.persistent);
		const part = mine.length ? mine : persistent;
		const drivers = [...new Set(part.map((r) => r.driver as string))];
		const perDriver = drivers.map((d) => {
			const x = part.filter((r) => r.driver === d);
			return {
				driver: d,
				certificate: modeOf(x.map((r) => r.certificate)),
				stable: new Set(x.map((r) => `${r.route}/${r.reason}`)).size === 1,
				reason: modeOf(x.map((r) => r.reason)),
				certifyMs: median(x.map((r) => r.certifyMs as number)),
				cacheHit: x.filter((r) => r.cacheHit).length
			};
		});
		out[mode] = {
			rows: part.length,
			persistent: mine.length === 0,
			certificates: countBy(perDriver.map((p) => p.certificate)),
			unstableDrivers: perDriver.filter((p) => !p.stable).map((p) => p.driver),
			reasons: countBy(perDriver.map((p) => p.reason)),
			certifyMsMedianPerDriver: median(perDriver.map((p) => p.certifyMs)),
			certifyMsTotal: sum(perDriver.map((p) => p.certifyMs)),
			cacheHits: sum(perDriver.map((p) => p.cacheHit)),
			perDriver
		};
	}
	return out;
}

// #endregion

// #region whole run

export function analyze(config: Config) {
	const manifest = JSON.parse(readFileSync(config.manifest, 'utf8')) as {
		projects: { id: string; drivers: { id: string }[] }[];
	};
	const owner = new Map(manifest.projects.flatMap((p) => p.drivers.map((d) => [d.id, p.id] as const)));
	const projectOf = (d: string) => owner.get(d) ?? '?';
	const archResults: Record<string, any> = {};
	for (const [name, arch] of Object.entries(config.archs)) {
		const first = arch.sessions.find((s) => existsSync(s.rows)) ?? arch.sessions[0];
		const drivers = [
			...new Set(
				(first ? readRows(first.rows) : [])
					.filter((r) => r.kind === 'run')
					.flatMap((r) => r.drivers as string[])
			)
		];
		const correct = arch.correct ? readRows(arch.correct) : [];
		const correctSamples = samplesOf(correct);
		const sessions = arch.sessions.map((s) => analyzeSession(s, arch.host, drivers, projectOf));
		const sampleSets = arch.sessions.map((s) => ({ label: s.label, samples: samplesOf(readRows(s.rows)) }));
		const pooledArms: Record<string, any> = {};
		for (const arm of FOLIO) {
			if (sampleSets.every((s) => s.samples.some((r) => r.arm === arm)))
				pooledArms[arm] = pooled(sampleSets, arm, drivers, projectOf);
		}
		const routerSessions = sessions.map((s) => s.arms.router?.gates);
		const gateRow = (pick: (g: Gates) => boolean) =>
			routerSessions.map((g) => (g ? pick(g) : false));
		const g1 = gateRow((g) => g.gate1);
		const g2 = gateRow((g) => g.gate2);
		const wrongTotal = sum(sessions.map((s) => s.wrong.length)) + correctSamples.filter((s) => !s.passed).length;
		const errorsTotal = sum(sessions.map((s) => s.errors.length)) + correct.filter((r) => r.kind === 'error').length;
		const allSamples = sampleSets.flatMap((s) => s.samples);
		archResults[name] = {
			host: arch.host,
			drivers: drivers.length,
			correctness: {
				rows: correctSamples.length,
				wrong: correctSamples.filter((s) => !s.passed).map((s) => ({ driver: s.driver, arm: s.arm })),
				errors: correct.filter((r) => r.kind === 'error').map((r) => ({ driver: r.driver, arm: r.arm, status: r.status, stderr: r.stderr })),
				serialMismatches: sum(correct.filter((r) => r.kind === 'check').map((r) => r.serialMismatches?.length ?? 0)),
				routes: correctSamples.length ? routesOf(correctSamples, drivers) : undefined,
				certify: arch.certify ? certifySummary(readRows(arch.certify)) : undefined
			},
			sessions,
			pooled: pooledArms,
			routes: allSamples.length ? routesOf(allSamples, drivers) : undefined,
			w3: Object.fromEntries(
				['router'].flatMap((arm) => {
					const t = pooledArms[arm]?.table as DriverStat[] | undefined;
					return t ? [[arm, w3Readings(t)]] : [];
				})
			),
			verdict: {
				sessions: sessions.length,
				gate1BySession: g1,
				gate2BySession: g2,
				gate3: wrongTotal === 0,
				gate1: g1.length > 0 && g1.every(Boolean),
				gate2: g2.length > 0 && g2.every(Boolean),
				wrongTotal,
				errorsTotal,
				medianOfSessions: {
					geomean: median(routerSessions.filter((g): g is Gates => !!g).map((g) => g.geomean)),
					min: median(routerSessions.filter((g): g is Gates => !!g).map((g) => g.min))
				}
			}
		};
	}
	const verdicts = Object.values(archResults).map((a: any) => a.verdict);
	const complete = Object.keys(config.archs).length === 2 && verdicts.every((v: any) => v.sessions === 3);
	return {
		archs: archResults,
		overall: {
			complete,
			gate1: complete && verdicts.every((v: any) => v.gate1),
			gate2: complete && verdicts.every((v: any) => v.gate2),
			gate3: complete && verdicts.every((v: any) => v.gate3)
		}
	};
}

// #endregion

// #region markdown

const met = (b: boolean) => (b ? 'MET' : 'NOT MET');

export function markdown(result: ReturnType<typeof analyze>): string {
	const out: string[] = [];
	for (const [name, a] of Object.entries(result.archs) as [string, any][]) {
		out.push(`## Architecture ${name}`, '');
		out.push(
			`Correctness pass: ${a.correctness.rows} rows, wrong outputs ${a.correctness.wrong.length}, errors ${a.correctness.errors.length}, serial mismatches ${a.correctness.serialMismatches}.`,
			''
		);
		out.push(
			'| Session | Span (UTC) | Rows | Errors | Wrong | Flagged | Over 50x median | Load label | Router geomean | Min | p10 (harness) | Gate 1 | Gate 2 |',
			'| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |'
		);
		for (const s of a.sessions as SessionResult[]) {
			const g = s.arms.router?.gates;
			out.push(
				`| ${s.label} | ${s.timeSpan ? s.timeSpan.map((t) => t.slice(11, 16)).join(' to ') : 'NA'} | ${s.samples} | ${s.errors.length} | ${s.wrong.length} | ${s.flagged} | ${s.over50.length} | ${(s.sampler.label as string) ?? 'no sampler'} | ${g ? f3(g.geomean) : 'NA'} | ${g ? f3(g.min) : 'NA'} | ${g ? f3(g.p10) : 'NA'} | ${g ? met(g.gate1) : 'NA'} | ${g ? met(g.gate2) : 'NA'} |`
			);
		}
		const pr = a.pooled.router as { gates: Gates } | undefined;
		if (pr)
			out.push(
				`| pooled 30 rounds | | | | | | | | ${f3(pr.gates.geomean)} | ${f3(pr.gates.min)} | ${f3(pr.gates.p10)} | ${met(pr.gates.gate1)} | ${met(pr.gates.gate2)} |`
			);
		out.push('');
		for (const s of a.sessions as SessionResult[]) {
			out.push(`### Session ${s.label}: contamination and load`, '');
			out.push(
				`Rows ${s.samples}, errors ${s.errors.length}, wrong outputs ${s.wrong.length}, flagged ${s.flagged} (${describe(s.flagReasons) || 'none'}), over 50x the arm median ${s.over50.length}${s.routerWithout50 ? `; router geomean without them ${f3(s.routerWithout50.geomean)}, min ${f3(s.routerWithout50.min)}` : ''}.`
			);
			out.push(`Sampler: ${JSON.stringify(s.sampler)}.`, '');
			for (const e of s.errors.slice(0, 5))
				out.push(`Error row: ${e.driver} ${e.arm} round ${e.round} status ${e.status} ${String(e.stderr).slice(-200)}`);
			for (const w of s.wrong.slice(0, 20)) out.push(`Wrong output: ${w.driver} ${w.arm} round ${w.round}`);
			for (const o of s.over50.slice(0, 20)) out.push(`Over 50x: ${o.driver} ${o.arm} round ${o.round} ${f2(o.wallMs)} ms`);
			out.push('');
		}
		out.push(`### Per-arm figures (${name})`, '');
		out.push('| Arm | Set | Geomean | 95% (drivers) | P(>= 1.20) | Min | p10 | Slowest five | Gate 1 | Gate 2 |', '| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- |');
		const line = (arm: string, label: string, g: Gates) =>
			`| ${arm} | ${label} | ${f3(g.geomean)} | ${f3(g.boot.geomeanLo)} to ${f3(g.boot.geomeanHi)} | ${f2(g.boot.pGeomean)} | ${f3(g.min)} | ${f3(g.p10)} | ${g.slowest.map((x) => `${x.driver} ${f3(x.speedup)}`).join('; ')} | ${met(g.gate1)} | ${met(g.gate2)} |`;
		for (const arm of FOLIO) {
			for (const s of a.sessions as SessionResult[]) if (s.arms[arm]) out.push(line(arm, s.label, s.arms[arm]!.gates));
			if (a.pooled[arm]) out.push(line(arm, 'pooled', a.pooled[arm].gates));
		}
		out.push('');
		if (pr) {
			out.push(`### Router per driver, pooled (${name}), sorted by speedup`, '');
			out.push('| Driver | Project | Speedup | 95% of rounds | Min to max | Serial ms | Router ms |', '| --- | --- | ---: | --- | --- | ---: | ---: |');
			for (const t of [...(pr as any).table as DriverStat[]].sort((x, y) => x.speedup - y.speedup))
				out.push(`| ${t.driver} | ${t.project} | ${f3(t.speedup)} | ${f3(t.lo)} to ${f3(t.hi)} | ${f3(t.min)} to ${f3(t.max)} | ${f3(t.serialMs)} | ${f3(t.armMs)} |`);
			out.push('');
			const slow = ((pr as any).table as DriverStat[]).filter((t) => t.speedup < 1).sort((x, y) => x.speedup - y.speedup);
			out.push(`Slowdowns (pooled router speedup below 1.00): ${slow.length}.`, '');
			for (const t of slow) out.push(`- ${t.driver}: ${f3(t.speedup)} (95% ${f3(t.lo)} to ${f3(t.hi)}${t.hi < 1 ? ', interval wholly below 1.00' : ''})`);
			out.push('');
			const w = a.w3.router;
			out.push(`W3 readings, router, pooled (${name}): geomean ${f3(w.all)}; without ${w.without1.dropped.join(', ')} ${f3(w.without1.geomean)}; without ${w.without2.dropped.join(' and ')} ${f3(w.without2.geomean)}.`, '');
			out.push('| Project | Drivers | Geomean | Min |', '| --- | ---: | ---: | ---: |');
			for (const p of w.projects) out.push(`| ${p.project} | ${p.drivers} | ${f3(p.geomean)} | ${f3(p.min)} |`);
			out.push('');
		}
		const routes = a.routes as Record<string, any> | undefined;
		if (routes) {
			out.push(`### Routes, reasons and certificates per arm (${name}, all sessions)`, '');
			out.push('| Arm | Rows | Routes of rows | Modal route per driver | Certificate per driver | Reasons of rows |', '| --- | ---: | --- | --- | --- | --- |');
			for (const [arm, r] of Object.entries(routes))
				out.push(`| ${arm} | ${r.rows} | ${describe(r.routes)} | ${describe(r.modalRouteDrivers)} | ${describe(r.certificateDrivers)} | ${describe(r.reasons)} |`);
			out.push('');
			out.push('Cost per arm, median of rows in ms (certify, setup, open, prepare, first run, probe):', '');
			for (const [arm, r] of Object.entries(routes)) out.push(`- ${arm}: ${Object.entries(r.cost as Record<string, number | null>).map(([k, v]) => `${k} ${v === null ? 'NA' : f2(v)}`).join(', ')}`);
			out.push('');
			const router = routes.router;
			if (router) {
				out.push(`Router per driver (${name}): route counts, reasons, certificate:`, '');
				for (const p of router.perDriver) out.push(`- ${p.driver}: ${describe(p.routes)}; ${describe(p.reasons)}; certificate ${p.certificate}${p.refusal !== '-' ? `; refusal ${p.refusal}` : ''}`);
				out.push('');
			}
		}
		const cs = a.correctness.certify as Record<string, any> | undefined;
		if (cs) {
			out.push(`### Certify stage (${name})`, '');
			out.push('| Mode | Certificates | Refusal reasons | Certify ms median per driver | Certify ms total | Cache hits | Unstable drivers |', '| --- | --- | --- | ---: | ---: | ---: | --- |');
			for (const [mode, c] of Object.entries(cs))
				out.push(`| ${mode}${c.persistent ? ' (persistent cache)' : ''} | ${describe(c.certificates)} | ${describe(c.reasons)} | ${f2(c.certifyMsMedianPerDriver)} | ${f2(c.certifyMsTotal)} | ${c.cacheHits} | ${c.unstableDrivers.join(', ') || 'none'} |`);
			out.push('');
		}
		const v = a.verdict;
		out.push(`### Verdict (${name})`, '');
		out.push(`- Gate 1 (geomean at least 1.20) by session ${v.gate1BySession.map(met).join(', ')}; architecture ${met(v.gate1)}.`);
		out.push(`- Gate 2 (every one of the slowest five at least 0.90) by session ${v.gate2BySession.map(met).join(', ')}; architecture ${met(v.gate2)}.`);
		out.push(`- Gate 3 (zero wrong outputs): wrong ${v.wrongTotal}, error rows ${v.errorsTotal}; ${met(v.gate3)}.`);
		out.push(`- Median of the session values: geomean ${f3(v.medianOfSessions.geomean)}, min ${f3(v.medianOfSessions.min)}.`, '');
	}
	const o = result.overall;
	out.push('## Overall', '', `Complete (2 architectures, 3 sessions each): ${o.complete}. Gate 1 ${met(o.gate1)}, gate 2 ${met(o.gate2)}, gate 3 ${met(o.gate3)}.`, '');
	return out.join('\n');
}

// #endregion

// #region selftest

function selftest() {
	const dir = join(tmpdir(), `final-eval-selftest-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	const drivers = ['a-one', 'a-two', 'b-three'];
	const manifest = { projects: [{ id: 'a', drivers: [{ id: 'a-one' }, { id: 'a-two' }] }, { id: 'b', drivers: [{ id: 'b-three' }] }] };
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
	// serial 10 ms; router 5 ms (x2.0) for a-one, 10 ms (x1.0) for a-two, 20 ms (x0.5) for b-three
	const router: Record<string, number> = { 'a-one': 5, 'a-two': 10, 'b-three': 20 };
	const lines: string[] = [JSON.stringify({ kind: 'run', drivers })];
	const sess = (name: string, extra: (d: string, arm: string, round: number) => Partial<Row>) => {
		const rows = [JSON.stringify({ kind: 'run', drivers })];
		for (let round = 0; round < 4; round++)
			for (const d of drivers)
				for (const arm of ['serial', 'router']) {
					const wall = arm === 'serial' ? 10 : router[d]!;
					rows.push(JSON.stringify({ kind: 'sample', driver: d, arm, round, wallMs: wall, passed: true, route: arm === 'serial' ? 'serial' : 'window', reason: 'x', t0: 1000 + round, t1: 1000.5 + round, loadStart: [1, 1], loadEnd: [1, 1], ...extra(d, arm, round) }));
				}
		rows.push(JSON.stringify({ kind: 'check', rows: 24, wrong: 0, serialMismatches: [] }));
		writeFileSync(join(dir, `${name}.jsonl`), rows.join('\n') + '\n');
		return join(dir, `${name}.jsonl`);
	};
	void lines;
	const s1 = sess('s1', () => ({}));
	const s2 = sess('s2', (d, arm, round) => (d === 'a-one' && arm === 'router' && round === 3 ? { wallMs: 5000, passed: false } : {}));
	const config: Config = { manifest: join(dir, 'manifest.json'), archs: { test: { host: 'rig', sessions: [{ label: 's1', rows: s1 }, { label: 's2', rows: s2 }] } } };
	const result = analyze(config);
	const t = result.archs.test;
	const check = (name: string, ok: boolean) => {
		if (!ok) throw new Error(`selftest failed: ${name}`);
		console.log('ok', name);
	};
	const g1 = t.sessions[0].arms.router.gates as Gates;
	check('geomean of 2, 1, 0.5 is 1', Math.abs(g1.geomean - 1) < 1e-9);
	check('gate 1 not met at 1.0', !g1.gate1);
	check('min is 0.5 and gate 2 not met', g1.min === 0.5 && !g1.gate2);
	check('slowest count is ceil(0.3) = 1 and names b-three', g1.slowestCount === 1 && g1.slowest[0]!.driver === 'b-three');
	check('session 2 has one wrong output counted', t.sessions[1].wrong.length === 1);
	check('session 2 flags one row over 50x', t.sessions[1].over50.length === 1);
	check('gate 3 fails', !t.verdict.gate3 && t.verdict.wrongTotal === 1);
	check('incomplete run is not overall met', !result.overall.complete && !result.overall.gate1);
	check('project readings', t.w3.router.projects.length === 2);
	check('bootstrap is deterministic', gatesOf([{ driver: 'x', speedup: 2 }, { driver: 'y', speedup: 0.5 }], ['x', 'y']).boot.geomeanLo === gatesOf([{ driver: 'x', speedup: 2 }, { driver: 'y', speedup: 0.5 }], ['x', 'y']).boot.geomeanLo);
	check('missing driver blocks the gate', !gatesOf([{ driver: 'x', speedup: 2 }], ['x', 'y']).gate1);
	check('rig flag on another container', rigFlags({ t0: 10, t1: 11 }, [{ t: 10.5, load: 1, busy: 5, containers: [{ name: 'other', cpu: 50 }, { name: 'rig-w4-final-x', cpu: 800 }] }]).includes('other-container'));
	check('rig flag clear for own container', rigFlags({ t0: 10, t1: 11 }, [{ t: 10.5, load: 1, busy: 34, containers: [{ name: 'rig-w4-final-x', cpu: 800 }] }]).length === 0);
	check('mac flag at load 12', macFlags({ t0: 10, t1: 11, loadStart: [12.5, 1] }, []).length === 1);
	check('markdown renders', markdown(result).includes('Overall'));
}

// #endregion

if (import.meta.main) {
	const [first, prefix] = process.argv.slice(2);
	if (first === '--selftest') selftest();
	else if (first && prefix) {
		const result = analyze(JSON.parse(readFileSync(first, 'utf8')) as Config);
		writeFileSync(`${prefix}.json`, JSON.stringify(result, null, '\t') + '\n');
		writeFileSync(`${prefix}.md`, markdown(result) + '\n');
		console.log('wrote', `${prefix}.json`, `${prefix}.md`);
	} else throw new Error('usage: analyze.ts CONFIG.json OUT_PREFIX | --selftest');
}
