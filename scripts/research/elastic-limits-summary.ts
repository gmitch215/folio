import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CONTROL_OF, LADDER_CLASSES } from '../../experiments/elastic-limits/config.ts';
import { digest } from './environment.ts';

export type Row = Record<string, any>;
export interface MeterRow {
	cls: string;
	minute: string;
	maxMemoryBytes: number;
	cpuTimeUs?: number;
	exceededCpu?: number;
	exceededMemory?: number;
	rowsWritten: number;
	rowsRead: number;
}
export interface Meter {
	rows?: MeterRow[];
	classes?: { cls: string; mib: number; touch: boolean | null; repeat: number }[];
	settled?: boolean;
	polls?: number;
}

const MIB = 1048576;
const mib = (bytes: number) => Math.round((bytes / MIB) * 1000) / 1000;
const ms = (value: number) => Math.round(value * 1000) / 1000;

export function quantile(values: number[], p: number) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const at = (sorted.length - 1) * p;
	const low = Math.floor(at);
	return sorted[low]! + (sorted[Math.ceil(at)]! - sorted[low]!) * (at - low);
}
export const median = (values: number[]) => quantile(values, 0.5);
const round = (value: number | null) => (value === null ? null : ms(value));

export const parseLines = (text: string): Row[] =>
	text
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));

const clients = (raw: Row[], rung: number | string) =>
	raw.filter((r) => r.rung === rung && r.level === 'client');
const inners = (raw: Row[], rung: number | string) =>
	raw.filter((r) => r.rung === rung && r.level === 'inner');
const groupBy = <T>(rows: T[], key: (row: T) => string) => {
	const out = new Map<string, T[]>();
	for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), row]);
	return out;
};
const stats = (values: number[]) => ({
	n: values.length,
	median: round(median(values)),
	p90: round(quantile(values, 0.9)),
	min: values.length ? round(Math.min(...values)) : null,
	max: values.length ? round(Math.max(...values)) : null
});

// sixteen writes per request in three shapes against a no-op request, per size
export function rung1(raw: Row[]) {
	const rows = clients(raw, 1).filter((r) => r.status === 200);
	const base = median(rows.filter((r) => r.shape === 'none').map((r) => r.wallMs));
	assert.ok(base !== null, 'rung 1 has no no-op base');
	const cells: Row[] = [];
	for (const shape of ['await', 'noawait', 'sql'])
		for (const size of [...new Set(rows.map((r) => r.size))]
			.filter((s) => s > 0)
			.sort((a, b) => a - b)) {
			const mine = rows.filter(
				(r) => r.shape === shape && r.size === size && r.op === 'write'
			);
			if (!mine.length) continue;
			const writes = mine[0]!.n;
			const wall = mine.map((r) => r.wallMs);
			cells.push({
				shape,
				sizeKiB: size / 1024,
				requests: mine.length,
				writesPerRequest: writes,
				wallMedianMs: round(median(wall)),
				wallP90Ms: round(quantile(wall, 0.9)),
				netMedianMs: round(median(wall)! - base),
				netPerWriteMs: round((median(wall)! - base) / writes)
			});
		}
	const sizes = [...new Set(cells.map((c) => c.sizeKiB))];
	const spread = sizes.map((sizeKiB) => {
		const at = cells.filter((c) => c.sizeKiB === sizeKiB).map((c) => c.wallMedianMs!);
		return { sizeKiB, wallMedianRatioMaxOverMin: round(Math.max(...at) / Math.min(...at)) };
	});
	const putMs = inners(raw, 1).map((r) => r.ms);
	return {
		noopBase: { n: rows.filter((r) => r.shape === 'none').length, medianMs: round(base) },
		cells,
		spread,
		putInsideObject: { n: putMs.length, maxMs: putMs.length ? Math.max(...putMs) : null }
	};
}

// sequential no-op calls from an executor to an owner, per mode and hint
export function rung2(raw: Row[]) {
	const modes = [...groupBy(inners(raw, 2), (r) => r.shape)].sort(([a], [b]) =>
		a.localeCompare(b)
	);
	const failures = clients(raw, 2).filter((r) => r.status !== 200 || r.error);
	return {
		modes: modes.map(([shape, rows]) => ({ shape, ...stats(rows.map((r) => r.ms)) })),
		firstCall: stats(
			inners(raw, 2)
				.filter((r) => r.i === -1)
				.map((r) => r.ms)
		),
		clientRequests: clients(raw, 2).length,
		failedClientRequests: failures.length,
		colos: [
			...new Set(
				clients(raw, 2)
					.map((r) => r.colo)
					.filter(Boolean)
			)
		].sort()
	};
}

// how many stub calls one invocation makes
export function rung3(raw: Row[]) {
	return clients(raw, 3).map((r) => ({
		shape: r.shape,
		repeat: r.repeat,
		requested: r.requested,
		ok: r.ok,
		errorAt: r.errorAt ?? null,
		error: r.error
			? String(r.error)
					.split('.')[0]!
					.replace(/^Error: /, '')
			: null,
		status: r.status
	}));
}

// cpu-bound requests against the no-op request of the same run
export function rung4(raw: Row[]) {
	const rows = clients(raw, 4);
	const noop = rows.filter((r) => r.shape === 'noop' && !r.warmup).map((r) => r.wallMs);
	const loops = rows.filter((r) => r.shape !== 'noop');
	return {
		requests: rows.length,
		ok: rows.filter((r) => r.status === 200).length,
		noopMedianMs: round(median(noop)),
		noopN: noop.length,
		maxIters: Math.max(...loops.map((r) => r.iters)),
		maxWallMs: round(Math.max(...loops.map((r) => r.wallMs))),
		loops: loops.map((r) => ({
			shape: r.shape,
			iters: r.iters,
			wallMs: round(r.wallMs),
			status: r.status
		}))
	};
}

// colocated read-modify-write cycles of one blob; the slope is wall against cycle count per repeat
export function rung5(raw: Row[]) {
	const rows = clients(raw, 5).filter((r) => r.status === 200);
	const rmw = rows.filter((r) => r.shape === 'rmw');
	const slopes = [...groupBy(rmw, (r) => String(r.repeat))].flatMap(([repeat, set]) => {
		const lo = set.reduce((a, b) => (b.n < a.n ? b : a));
		const hi = set.reduce((a, b) => (b.n > a.n ? b : a));
		if (lo === hi) return [];
		return [
			{ repeat: Number(repeat), msPerCycle: ms((hi.wallMs - lo.wallMs) / (hi.n - lo.n)) }
		];
	});
	const wall = (shape: string) =>
		rows.filter((r) => r.shape === shape).map((r) => ({ n: r.n, wallMs: round(r.wallMs) }));
	return {
		sizeKiB: rows[0]?.size / 1024,
		rmw: wall('rmw'),
		read: wall('read'),
		base: wall('base'),
		slopes
	};
}

// the platform meter per class: minutes, peak and written rows
export function meterClasses(meter: Meter) {
	return [...groupBy(meter.rows ?? [], (r) => r.cls)]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([cls, rows]) => ({
			cls,
			minutes: rows.length,
			maxMiB: mib(Math.max(...rows.map((r) => r.maxMemoryBytes))),
			minMiB: mib(Math.min(...rows.map((r) => r.maxMemoryBytes))),
			rowsWritten: rows.reduce((a, r) => a + r.rowsWritten, 0),
			rowsRead: rows.reduce((a, r) => a + r.rowsRead, 0),
			exceeded: rows.reduce((a, r) => a + (r.exceededCpu ?? 0) + (r.exceededMemory ?? 0), 0)
		}));
}

// linear memory by size and touch: the class maximum per instance, null when the meter has no row
export function rung7(meter: Meter) {
	const classes = meter.classes ?? [];
	const peakOf = (cls: string) => {
		const rows = (meter.rows ?? []).filter((r) => r.cls === cls);
		return rows.length ? mib(Math.max(...rows.map((r) => r.maxMemoryBytes))) : null;
	};
	const cells = [...groupBy(classes, (c) => `${c.mib}|${c.touch}`)].map(([, set]) => {
		const values = set.map((c) => peakOf(c.cls));
		const measured = values.filter((v): v is number => v !== null);
		return {
			linearMiB: set[0]!.mib,
			arm: set[0]!.touch === null ? 'bare' : set[0]!.touch ? 'written' : 'untouched',
			planned: set.length,
			measured: measured.length,
			values: set.map((c, i) => ({ repeat: c.repeat, meterMiB: values[i] })),
			minMiB: measured.length ? Math.min(...measured) : null,
			maxMiB: measured.length ? Math.max(...measured) : null
		};
	});
	return { classes: classes.length, cells };
}

export function runFacts(counters: Row, cleanup: Row, meter: Meter, raw: Row[]) {
	const seen = counters.seen;
	const planned = counters.planned;
	return {
		lines: raw.length,
		clientCalls: raw.filter((r) => r.level === 'client').length,
		rowsSeen: seen.writeRows + seen.schemaRows + seen.cleanupRows,
		rowsPlanned: planned.writeRows + planned.schemaRows + planned.cleanupRows,
		requestsSeen: seen.requests,
		requestsPlanned: planned.requests + planned.cleanupRequests,
		internalSeen: seen.internal,
		internalPlanned: planned.internal,
		retries: counters.retries,
		failure: counters.failure ?? null,
		accountEqualsBaseline: cleanup.accountEqualsBaseline ?? null,
		meterSettled: meter.settled ?? null,
		meterPolls: meter.polls ?? null,
		meterRows: meter.rows?.length ?? 0,
		meterRowsWritten: (meter.rows ?? []).reduce((a, r) => a + r.rowsWritten, 0)
	};
}

// the largest meter sample of a class over a window of UTC minutes, in MiB
export function peak(meter: Meter, cls: string, from: string, to: string) {
	const rows = (meter.rows ?? []).filter(
		(r) => r.cls === cls && r.minute >= from && r.minute <= to
	);
	return rows.length ? mib(Math.max(...rows.map((r) => r.maxMemoryBytes))) : null;
}
const minuteAfter = (minute: string, k: number) =>
	new Date(Date.parse(minute) + k * 60000).toISOString().slice(0, 17) + '00Z';
const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : ms(a - b));

// the first ladder runs wrote no minute fields, so the minute comes from the call start and wall
const minuteOf = (iso: string) => iso.slice(0, 16) + ':00Z';
const startOf = (r: Row): string => r.startMinute ?? minuteOf(r.ts);
const endOf = (r: Row): string =>
	r.endMinute ?? minuteOf(new Date(Date.parse(r.ts) + r.wallMs).toISOString());

// rung 6: one spill per object in a class of its own mode, against the class control hold
export function rung6(raw: Row[], meter: Meter) {
	const rows = clients(raw, 6);
	const objects = [...groupBy(rows, (r) => r.object)].map(([object, set]) => {
		const role = set[0]!.role as string;
		const cls = LADDER_CLASSES.find((c) => c.toLowerCase() === role) ?? role;
		const control = set.some((r) => String(r.shape).startsWith('control'));
		const from = set.map(startOf).sort()[0]!;
		const to = set.map(endOf).sort().at(-1)!;
		const spill = set.filter((r) => r.op === 'spill');
		const hold = set.filter((r) => r.op === 'hold');
		return {
			cls,
			control,
			repeat: set[0]!.repeat as number,
			window: [from, to],
			peakMiB: peak(meter, cls, from, to),
			spillWallMs: spill.map((r) => round(r.wallMs)),
			spillAttempts: spill.length,
			holdStatuses: hold.map((r) => r.status),
			plannedRows: spill[0]?.rows ?? null,
			sqlRows: spill[0]?.sqlRows ?? null,
			bytes: spill[0]?.bytes ?? null
		};
	});
	const controlOf = (cls: string) =>
		objects.find((o) => o.control && o.cls === cls)?.peakMiB ?? null;
	return objects
		.sort((a, b) => a.cls.localeCompare(b.cls) || a.repeat - b.repeat)
		.map((o) => ({
			...o,
			idleMiB: controlOf(o.cls),
			rMiB: o.control ? null : diff(o.peakMiB, controlOf(o.cls))
		}));
}

// rungs 6b to 6e: each hold against the idle control hold of its class
export function holds(raw: Row[], meter: Meter) {
	const spillRaw = raw.filter(
		(r) => ['6b', '6c', '6d', '6e'].includes(r.rung) && r.level === 'client'
	);
	const spillIsolate = new Map<string, string>();
	for (const r of spillRaw) if (r.op === 'spill') spillIsolate.set(r.object, r.isolate);
	const idleOf = (cls: string) => {
		const control = CONTROL_OF[cls]
			? spillRaw.find((r) => r.op === 'hold' && r.class === CONTROL_OF[cls])
			: undefined;
		return control
			? peak(meter, CONTROL_OF[cls]!, control.startMinute, control.endMinute)
			: null;
	};
	const out = spillRaw
		.filter((r) => r.op === 'hold')
		.map((h) => {
			const own = peak(meter, h.class, h.startMinute, h.endMinute);
			const idle = idleOf(h.class);
			return {
				rung: h.rung as string,
				arm: h.arm as string,
				cls: h.class as string,
				shape: h.shape as string,
				repeat: h.repeat as number,
				hold: (h.hold ?? null) as number | null,
				mib: (h.mib ?? null) as number | null,
				rowBytes: (h.rowBytes ?? null) as number | null,
				window: [h.startMinute as string, h.endMinute as string],
				status: h.status as number,
				peakMiB: own,
				idleMiB: idle,
				rMiB: diff(own, idle),
				isolate: String(h.shape).startsWith('fresh-')
					? h.isolate === spillIsolate.get(h.object)
						? 'same'
						: 'fresh'
					: null,
				caller: (h.caller ?? null) as string | null,
				callerRMiB: h.caller
					? diff(peak(meter, h.caller, h.startMinute, h.endMinute), idleOf(h.caller))
					: null
			};
		});
	return { holds: out, idleOf };
}

// R per arm and per repeat for the arms that name a row size or a spill size
export function arms(raw: Row[], meter: Meter) {
	const { holds: list } = holds(raw, meter);
	const key = (h: (typeof list)[number]) => `${h.rung} ${h.arm} ${h.cls} ${h.shape}`;
	return [
		...groupBy(
			list.filter((h) => !h.cls.startsWith('Ctl') && h.rMiB !== null),
			key
		)
	].map(([name, set]) => ({
		arm: name,
		rung: set[0]!.rung,
		cls: set[0]!.cls,
		mib: set[0]!.mib,
		rowKiB: set[0]!.rowBytes === null ? null : set[0]!.rowBytes / 1024,
		n: set.length,
		rMiB: set.map((h) => h.rMiB as number),
		statuses: set.map((h) => h.status),
		isolates: set.map((h) => h.isolate),
		medianRMiB: round(median(set.map((h) => h.rMiB as number)))
	}));
}

// the class row in the minutes after each clear, which can still hold the previous object
export function afterClear(raw: Row[], meter: Meter) {
	return raw
		.filter(
			(r) =>
				['6b', '6c', '6d', '6e'].includes(r.rung) &&
				r.level === 'client' &&
				r.op === 'clear'
		)
		.map((c) => ({
			rung: c.rung as string,
			cls: c.class as string,
			clearMinute: c.endMinute as string,
			plus1MiB: peak(
				meter,
				c.class,
				minuteAfter(c.endMinute, 1),
				minuteAfter(c.endMinute, 1)
			),
			plus2MiB: peak(meter, c.class, minuteAfter(c.endMinute, 2), minuteAfter(c.endMinute, 2))
		}));
}

// the decay class minute by minute from its spill, with the hold or clear that covers the minute
export function decay(raw: Row[], meter: Meter) {
	const rows = raw.filter((r) => r.rung === '6d' && r.arm === 'decay' && r.level === 'client');
	const { idleOf } = holds(raw, meter);
	const idle = idleOf('Decay');
	const out = [];
	for (const repeat of [...new Set(rows.map((r) => r.repeat))]) {
		const spill = rows.find((r) => r.op === 'spill' && r.repeat === repeat);
		if (!spill) continue;
		for (let m = 0; m <= 12; m++) {
			const minute = minuteAfter(spill.startMinute, m);
			const within = (r: Row) =>
				r.repeat === repeat && r.startMinute <= minute && minute <= r.endMinute;
			const hold = rows.find((r) => r.op === 'hold' && within(r));
			const clear = rows.find((r) => r.op === 'clear' && within(r));
			const own = peak(meter, 'Decay', minute, minute);
			out.push({
				repeat: repeat as number,
				minute,
				peakMiB: own,
				rMiB: diff(own, idle),
				covered: [hold ? `hold ${hold.hold}` : '', clear ? 'clear' : '']
					.filter(Boolean)
					.join(' + ')
			});
		}
	}
	return out;
}

// the namespace listing was paged at 20, so classes past it have rows only in the recovered file;
// unknown-N is the N-th class, in order of first spill, that has no row in the meter
export function mergeUnlisted(raw: Row[], meter: Meter, unlisted: Row[]) {
	const have = new Set((meter.rows ?? []).map((r) => r.cls));
	const spills = raw.filter((r) => r.level === 'client' && r.op === 'spill');
	const missing: string[] = [];
	for (const s of spills)
		if (!have.has(s.class) && !missing.includes(s.class)) missing.push(s.class);
	const labels = [...new Set(unlisted.map((r) => r.cls as string))];
	assert.equal(labels.length, missing.length, 'unlisted labels and classes without rows differ');
	const classOf = new Map(labels.map((label, i) => [label, missing[i]!]));
	for (const label of labels) {
		const first = unlisted.find((r) => r.cls === label)!;
		const spill = spills.find((s) => s.class === classOf.get(label))!;
		assert.equal(first.rowsWritten, spill.rows + spill.setupRows, `rows written of ${label}`);
	}
	const rows = unlisted.map((r) => ({
		cls: classOf.get(r.cls)!,
		minute: r.minute,
		maxMemoryBytes: r.maxMemoryBytes,
		rowsWritten: r.rowsWritten,
		rowsRead: r.rowsRead
	}));
	return { ...meter, rows: [...(meter.rows ?? []), ...rows] };
}

export function spillRun(raw: Row[], meter: Meter) {
	const h = holds(raw, meter).holds;
	return {
		controls: h
			.filter((x) => x.cls.startsWith('Ctl'))
			.map((x) => ({ cls: x.cls, shape: x.shape, peakMiB: x.peakMiB })),
		arms: arms(raw, meter),
		holds: h,
		afterClear: afterClear(raw, meter),
		decay: decay(raw, meter),
		rowsWritten: rowsWritten(raw, meter)
	};
}

// rows the platform counted per class against rows and schema rows the completed spills reported
export function rowsWritten(raw: Row[], meter: Meter) {
	const spills = raw.filter(
		(r) => r.level === 'client' && r.op === 'spill' && r.status === 200 && r.class
	);
	return [...groupBy(spills, (r) => r.class)].map(([cls, set]) => ({
		cls,
		spills: set.length,
		reported: set.reduce((a, r) => a + r.rows + r.setupRows, 0),
		meter: (meter.rows ?? [])
			.filter((r) => r.cls === cls)
			.reduce((a, r) => a + r.rowsWritten, 0)
	}));
}

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const load = (study: string, name: string) => ({
	raw: parseLines(readFileSync(join(study, name, 'raw.jsonl'), 'utf8')),
	rawSha256: digest(readFileSync(join(study, name, 'raw.jsonl'))),
	meter: read(join(study, name, 'meter.json')) as Meter,
	counters: read(join(study, name, 'counters.json')),
	cleanup: read(join(study, name, 'cleanup.json')),
	namespaces: existsSync(join(study, name, 'namespaces.json'))
		? read(join(study, name, 'namespaces.json'))
		: null
});

export function platformLadder(study: string) {
	const names = ['cpu-cap', 'spill-pilot', 'ladder', 'memory'];
	const runs = Object.fromEntries(names.map((name) => [name, load(study, name)]));
	return {
		schema: 'folio.platform-ladder.summary.v1',
		note: 'milliseconds and MiB are rounded to three decimals; n is the count behind each cell',
		runs: Object.fromEntries(
			names.map((name) => {
				const run = runs[name]!;
				return [
					name,
					{
						rawSha256: run.rawSha256,
						...runFacts(run.counters, run.cleanup, run.meter, run.raw),
						namespaces: run.namespaces?.count ?? null
					}
				];
			})
		),
		rung1: rung1(runs.ladder!.raw),
		rung2: rung2(runs.ladder!.raw),
		rung3: rung3(runs.ladder!.raw),
		rung4: { 'cpu-cap': rung4(runs['cpu-cap']!.raw), ladder: rung4(runs.ladder!.raw) },
		rung5: rung5(runs.ladder!.raw),
		rung7: { ...rung7(runs.memory!.meter), meterClasses: meterClasses(runs.memory!.meter) },
		ladderMeter: meterClasses(runs.ladder!.meter)
	};
}

export function spillMemory(study: string) {
	const names = ['restart-rows', 'size-ladder', 'row-size-sweep', 'row-size-cliff'];
	const runs = Object.fromEntries(names.map((name) => [name, load(study, name)]));
	const ladder = resolve(study, '../platform-ladder');
	const pilot = load(ladder, 'spill-pilot');
	const full = load(ladder, 'ladder');
	const unlisted = read(join(study, 'row-size-sweep', 'meter-unlisted.json')) as Row[];
	const sweep = runs['row-size-sweep']!;
	const sweepMeter = mergeUnlisted(sweep.raw, sweep.meter, unlisted);
	const merged = (sweepMeter.rows ?? []).slice((sweep.meter.rows ?? []).length) as Row[];
	return {
		schema: 'folio.spill-memory.summary.v1',
		note: 'MiB are rounded to three decimals; R is the class peak in the hold minutes minus the class idle control; n is the count behind each cell',
		runs: Object.fromEntries(
			names.map((name) => {
				const run = runs[name]!;
				return [
					name,
					{
						rawSha256: run.rawSha256,
						...runFacts(run.counters, run.cleanup, run.meter, run.raw),
						namespaces: run.namespaces?.count ?? null
					}
				];
			})
		),
		rung6: {
			note: 'raw lines are in the platform-ladder study',
			'spill-pilot': { rawSha256: pilot.rawSha256, objects: rung6(pilot.raw, pilot.meter) },
			ladder: { rawSha256: full.rawSha256, objects: rung6(full.raw, full.meter) },
			writtenClassesInLadder: meterClasses(full.meter).filter((c) =>
				['Owner', 'Store'].includes(c.cls)
			)
		},
		'restart-rows': spillRun(runs['restart-rows']!.raw, runs['restart-rows']!.meter),
		'size-ladder': spillRun(runs['size-ladder']!.raw, runs['size-ladder']!.meter),
		'row-size-sweep': {
			...spillRun(sweep.raw, sweepMeter),
			unlistedNamespaces: [...groupBy(unlisted, (r) => r.cls)].map(([label, rows]) => ({
				label,
				cls: merged[unlisted.findIndex((r) => r.cls === label)]!.cls,
				minutes: rows.length,
				maxMiB: mib(Math.max(...rows.map((r) => r.maxMemoryBytes))),
				rowsWritten: rows.reduce((a, r) => a + r.rowsWritten, 0)
			}))
		},
		'row-size-cliff': spillRun(runs['row-size-cliff']!.raw, runs['row-size-cliff']!.meter)
	};
}

// writes summary.json when it is missing; with the file present it compares the regenerated one
if (import.meta.main) {
	const study = resolve(process.argv[2] ?? '');
	const kind = basename(study);
	assert.ok(kind === 'platform-ladder' || kind === 'spill-memory', 'usage: STUDY_DIRECTORY');
	const summary = kind === 'platform-ladder' ? platformLadder(study) : spillMemory(study);
	const text = JSON.stringify(summary, null, 2) + '\n';
	const target = join(study, 'summary.json');
	if (existsSync(target)) {
		assert.equal(readFileSync(target, 'utf8'), text, 'regenerated summary differs');
		console.log(JSON.stringify({ summary: 'matches', file: 'summary.json' }));
	} else {
		writeFileSync(target, text);
		console.log(JSON.stringify({ summary: 'written', file: 'summary.json' }));
	}
}
