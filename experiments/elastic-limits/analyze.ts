import { readFileSync } from 'node:fs';
import { CONTROL_OF } from './config.ts';

// usage: node analyze.ts <run directory>; prints every rung's summary from raw.jsonl and meter.json
const dir = process.argv[2];
if (!dir) throw new Error('usage: node analyze.ts <run directory>');

const raw: any[] = readFileSync(`${dir}/raw.jsonl`, 'utf8')
	.trim()
	.split('\n')
	.map((line) => JSON.parse(line));
const meter = JSON.parse(readFileSync(`${dir}/meter.json`, 'utf8'));

const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const q = (a: number[], p: number) => {
	const s = sorted(a);
	if (!s.length) return NaN;
	const i = (s.length - 1) * p;
	const lo = Math.floor(i);
	return s[lo]! + (s[Math.ceil(i)]! - s[lo]!) * (i - lo);
};
const med = (a: number[]) => q(a, 0.5);
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const clients = (rung: number) => raw.filter((r) => r.rung === rung && r.level === 'client');
const inners = (rung: number) => raw.filter((r) => r.rung === rung && r.level === 'inner');
const by = <T>(rows: T[], key: (r: T) => string) => {
	const m = new Map<string, T[]>();
	for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
	return m;
};
const line = (...cells: (string | number)[]) => console.log(cells.join(' | '));

console.log(
	'# rung 1: write shapes (client wall of one request that does 16 writes, minus the no-op base)'
);
{
	const rows = clients(1).filter((r) => r.status === 200);
	const base = med(rows.filter((r) => r.shape === 'none').map((r) => r.wallMs));
	console.log('no-op base median ms', f(base));
	line(
		'shape',
		'size KiB',
		'n',
		'median wall ms',
		'p90 wall ms',
		'net of base ms',
		'net per write ms'
	);
	for (const shape of ['await', 'noawait', 'sql'])
		for (const size of [1, 4, 16, 64, 256]) {
			const w = rows
				.filter((r) => r.shape === shape && r.size === size * 1024 && r.op === 'write')
				.map((r) => r.wallMs);
			if (w.length)
				line(
					shape,
					size,
					w.length,
					f(med(w)),
					f(q(w, 0.9)),
					f(med(w) - base),
					f((med(w) - base) / 16, 2)
				);
		}
	console.log('awaited put measured inside the object (one sample per put, ms)');
	line('size KiB', 'n', 'median', 'p90', 'min', 'max');
	for (const size of [1, 4, 16, 64, 256]) {
		const m = inners(1)
			.filter((r) => r.size === size * 1024)
			.map((r) => r.ms);
		if (m.length)
			line(
				size,
				m.length,
				f(med(m), 2),
				f(q(m, 0.9), 2),
				f(Math.min(...m), 2),
				f(Math.max(...m), 2)
			);
	}
}

console.log('\n# rung 2: hops (inner ms per call)');
{
	line('mode', 'n', 'median', 'p90', 'min', 'max');
	for (const [k, rows] of [...by(inners(2), (r) => r.shape)].sort()) {
		const m = rows.map((r) => r.ms);
		line(
			k,
			m.length,
			f(med(m), 2),
			f(q(m, 0.9), 2),
			f(Math.min(...m), 2),
			f(Math.max(...m), 2)
		);
	}
	console.log('client rows: errors and colo');
	for (const r of clients(2))
		line(
			r.shape,
			'status',
			r.status,
			'wall',
			f(r.wallMs),
			'error',
			r.error ?? '',
			'colo',
			r.colo ?? '',
			r.probe ? JSON.stringify(r.probe) : ''
		);
}

console.log('\n# rung 3: subrequest limits');
for (const r of clients(3))
	line(
		r.shape,
		'count',
		r.count,
		'requested',
		r.requested,
		'ok',
		r.ok,
		'error',
		r.error ?? '',
		'errorAt',
		r.errorAt ?? '',
		'wall ms',
		f(r.wallMs, 0),
		'status',
		r.status
	);

console.log('\n# rung 4: CPU-bound requests');
{
	line('kind', 'iters', 'wall ms', 'status');
	for (const r of clients(4).filter((r) => r.shape !== 'noop'))
		line(r.shape, r.iters, f(r.wallMs, 0), r.status);
	const noop = clients(4)
		.filter((r) => r.shape === 'noop' && !r.warmup)
		.map((r) => r.wallMs);
	console.log('no-op median ms', f(med(noop)));
}

console.log('\n# rung 5: colocated read-modify-write of a 64 KiB blob through sql.exec');
{
	const rows = clients(5).filter((r) => r.status === 200);
	for (const shape of ['rmw', 'read', 'base']) {
		const set = rows.filter((r) => r.shape === shape);
		const byRepeat = by(set, (r) => String(r.repeat));
		const slopes: number[] = [];
		for (const [, rs] of byRepeat) {
			const small = rs.find((r) => r.n === Math.min(...rs.map((x) => x.n)));
			const large = rs.find((r) => r.n === Math.max(...rs.map((x) => x.n)));
			if (small && large && small !== large)
				slopes.push((large.wallMs - small.wallMs) / (large.n - small.n));
		}
		console.log(
			shape,
			'n values',
			[...new Set(set.map((r) => r.n))].join(','),
			'walls ms',
			set.map((r) => f(r.wallMs, 0)).join(' '),
			'slope ms per cycle per repeat',
			slopes.map((s) => f(s, 3)).join(' ')
		);
	}
}

console.log('\n# rung 6: spill of 64 MiB in 1 MiB extents');
{
	line('arm', 'op', 'n', 'wall ms (each)', 'errors');
	for (const [k, rows] of [...by(clients(6), (r) => `${r.shape}|${r.op}`)].sort())
		line(
			k,
			rows.length,
			rows.map((r) => `${f(r.wallMs, 0)}${r.status === 200 ? '' : '!' + r.status}`).join(' '),
			rows.filter((r) => r.status !== 200).length
		);
}

const MIB = 1048576;
// the largest meter sample of a class in a window of UTC minutes; NaN when the meter has no row there
const peak = (cls: string, from: string, to: string) => {
	const xs = (meter.rows ?? []).filter(
		(m: any) => m.cls === cls && m.minute >= from && m.minute <= to
	);
	return xs.length ? Math.max(...xs.map((m: any) => m.maxMemoryBytes / MIB)) : NaN;
};
const minuteAfter = (minute: string, k: number) =>
	new Date(Date.parse(minute) + k * 60000).toISOString().slice(0, 17) + '00Z';

console.log('\n# platform meter (durableObjectsPeriodicGroups, per class and minute)');
{
	line(
		'class',
		'minutes',
		'max MiB',
		'min MiB',
		'rows written',
		'rows read',
		'cpu ms',
		'exceeded'
	);
	for (const [cls, rows] of [...by<any>(meter.rows ?? [], (r) => r.cls)].sort()) {
		const mem = rows.map((r) => r.maxMemoryBytes / MIB);
		line(
			cls,
			rows.length,
			f(Math.max(...mem)),
			f(Math.min(...mem)),
			rows.reduce((a, r) => a + r.rowsWritten, 0),
			rows.reduce((a, r) => a + r.rowsRead, 0),
			f(rows.reduce((a, r) => a + r.cpuTimeUs, 0) / 1000, 0),
			rows.reduce((a, r) => a + r.exceededCpu + r.exceededMemory, 0)
		);
	}
	console.log('settled', meter.settled, 'polls', meter.polls);
}

// R = the class's largest sample in the hold minutes minus its idle control's largest sample in the control's hold
const spillRaw = raw.filter(
	(r) => ['6b', '6c', '6d', '6e'].includes(r.rung) && r.level === 'client'
);
const spillIsolate = new Map<string, string>();
for (const r of spillRaw) if (r.op === 'spill') spillIsolate.set(r.object, r.isolate);
const holdOf = (cls: string) => spillRaw.find((r) => r.op === 'hold' && r.class === cls);
const idleOf = (cls: string) => {
	const control = CONTROL_OF[cls] ? holdOf(CONTROL_OF[cls]!) : undefined;
	return control ? peak(CONTROL_OF[cls]!, control.startMinute, control.endMinute) : NaN;
};

console.log('\n# rungs 6b to 6e: each hold against its class idle control (MiB; R = peak - idle)');
{
	line(
		'rung',
		'arm',
		'class',
		'shape',
		'repeat',
		'window (UTC minutes)',
		'peak',
		'idle',
		'R',
		'isolate'
	);
	const holds = spillRaw.filter((r) => r.op === 'hold');
	const rOf = new Map<string, number[]>();
	for (const h of holds) {
		const own = peak(h.class, h.startMinute, h.endMinute);
		const idle = idleOf(h.class);
		const R = own - idle;
		const isolate = h.shape.startsWith('fresh-')
			? h.isolate === spillIsolate.get(h.object)
				? 'SAME (not a restart)'
				: 'fresh'
			: '';
		line(
			h.rung,
			h.arm,
			h.class,
			h.shape,
			h.repeat,
			`${h.startMinute}..${h.endMinute}`,
			f(own),
			f(idle),
			f(R),
			isolate
		);
		if (!h.class.startsWith('Ctl') && Number.isFinite(R))
			rOf.set(`${h.rung} ${h.arm} ${h.class} ${h.shape}`, [
				...(rOf.get(`${h.rung} ${h.arm} ${h.class} ${h.shape}`) ?? []),
				R
			]);
		if (h.caller) {
			const callerOwn = peak(h.caller, h.startMinute, h.endMinute);
			const callerIdle = idleOf(h.caller);
			line(
				h.rung,
				h.arm,
				`${h.caller} (caller)`,
				h.shape,
				h.repeat,
				`${h.startMinute}..${h.endMinute}`,
				f(callerOwn),
				f(callerIdle),
				f(callerOwn - callerIdle),
				''
			);
		}
	}
	console.log('per arm, R by class and shape (one value per repeat)');
	for (const [key, values] of [...rOf].sort())
		line(key, values.map((v) => f(v)).join(' '), 'median', f(med(values)));
}

console.log(
	'\n# rungs 6b to 6e: the minutes after each clear (a residue row is the previous object)'
);
{
	line('rung', 'class', 'clear minute', 'row +1 MiB', 'row +2 MiB');
	for (const c of spillRaw.filter((r) => r.op === 'clear'))
		line(
			c.rung,
			c.class,
			c.endMinute,
			f(peak(c.class, minuteAfter(c.endMinute, 1), minuteAfter(c.endMinute, 1))),
			f(peak(c.class, minuteAfter(c.endMinute, 2), minuteAfter(c.endMinute, 2)))
		);
}

// rungs 6d and 6e: R by row size, one value per repeat (each row arm's holds are its only hold)
console.log('\n# rungs 6d and 6e: R by row size (MiB; R = peak - idle, one value per repeat)');
{
	line('arm', 'class', 'MiB', 'row KiB', 'R values', 'median R');
	const arms = new Map<string, { cls: string; mib: number; kib: number; values: number[] }>();
	const rowHolds = spillRaw.filter(
		(r) => ['6d', '6e'].includes(r.rung) && r.op === 'hold' && r.rowBytes
	);
	for (const h of rowHolds) {
		const R = peak(h.class, h.startMinute, h.endMinute) - idleOf(h.class);
		const kib = h.rowBytes / 1024;
		const key = `${h.rung} ${h.arm}`;
		const a = arms.get(key) ?? { cls: h.class, mib: h.mib, kib, values: [] as number[] };
		a.values.push(R);
		arms.set(key, a);
	}
	for (const [arm, a] of arms) {
		const values = a.values.map((v) => f(v)).join(' ');
		line(arm, a.cls, a.mib, a.kib, values, 'median', f(med(a.values)));
	}
}

// rung 6d: the decay class minute by minute from its spill (R = peak - idle)
console.log('\n# rung 6d decay: the class per minute from its spill (MiB)');
{
	line('repeat', 'minute', 'peak', 'R', 'in');
	const decay = spillRaw.filter((r) => r.rung === '6d' && r.arm === 'decay');
	const idle = idleOf('Decay');
	for (const k of new Set(decay.map((r) => r.repeat))) {
		const spill = decay.find((r) => r.op === 'spill' && r.repeat === k);
		if (!spill) continue;
		for (let m = 0; m <= 12; m++) {
			const minute = minuteAfter(spill.startMinute, m);
			const own = peak('Decay', minute, minute);
			const within = (r: any) =>
				r.repeat === k && r.startMinute <= minute && minute <= r.endMinute;
			const hold = decay.find((r) => r.op === 'hold' && within(r));
			const clear = decay.find((r) => r.op === 'clear' && within(r));
			const phase = [hold ? `hold ${hold.hold}` : '', clear ? 'clear' : ''].filter(Boolean);
			line(k, minute, f(own), f(own - idle), phase.join(' + '));
		}
	}
}
