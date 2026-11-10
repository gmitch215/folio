import { readFileSync } from 'node:fs';

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

console.log('# rung 1: write shapes (client wall of one request that does 16 writes, minus the no-op base)');
{
	const rows = clients(1).filter((r) => r.status === 200);
	const base = med(rows.filter((r) => r.shape === 'none').map((r) => r.wallMs));
	console.log('no-op base median ms', f(base));
	line('shape', 'size KiB', 'n', 'median wall ms', 'p90 wall ms', 'net of base ms', 'net per write ms');
	for (const shape of ['await', 'noawait', 'sql'])
		for (const size of [1, 4, 16, 64, 256]) {
			const w = rows
				.filter((r) => r.shape === shape && r.size === size * 1024 && r.op === 'write')
				.map((r) => r.wallMs);
			if (w.length) line(shape, size, w.length, f(med(w)), f(q(w, 0.9)), f(med(w) - base), f((med(w) - base) / 16, 2));
		}
	console.log('awaited put measured inside the object (one sample per put, ms)');
	line('size KiB', 'n', 'median', 'p90', 'min', 'max');
	for (const size of [1, 4, 16, 64, 256]) {
		const m = inners(1)
			.filter((r) => r.size === size * 1024)
			.map((r) => r.ms);
		if (m.length) line(size, m.length, f(med(m), 2), f(q(m, 0.9), 2), f(Math.min(...m), 2), f(Math.max(...m), 2));
	}
}

console.log('\n# rung 2: hops (inner ms per call)');
{
	line('mode', 'n', 'median', 'p90', 'min', 'max');
	for (const [k, rows] of [...by(inners(2), (r) => r.shape)].sort()) {
		const m = rows.map((r) => r.ms);
		line(k, m.length, f(med(m), 2), f(q(m, 0.9), 2), f(Math.min(...m), 2), f(Math.max(...m), 2));
	}
	console.log('client rows: errors and colo');
	for (const r of clients(2)) line(r.shape, 'status', r.status, 'wall', f(r.wallMs), 'error', r.error ?? '', 'colo', r.colo ?? '', r.probe ? JSON.stringify(r.probe) : '');
}

console.log('\n# rung 3: subrequest limits');
for (const r of clients(3))
	line(r.shape, 'count', r.count, 'requested', r.requested, 'ok', r.ok, 'error', r.error ?? '', 'errorAt', r.errorAt ?? '', 'wall ms', f(r.wallMs, 0), 'status', r.status);

console.log('\n# rung 4: CPU-bound requests');
{
	line('kind', 'iters', 'wall ms', 'status');
	for (const r of clients(4).filter((r) => r.shape !== 'noop')) line(r.shape, r.iters, f(r.wallMs, 0), r.status);
	const noop = clients(4).filter((r) => r.shape === 'noop' && !r.warmup).map((r) => r.wallMs);
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
			if (small && large && small !== large) slopes.push((large.wallMs - small.wallMs) / (large.n - small.n));
		}
		console.log(shape, 'n values', [...new Set(set.map((r) => r.n))].join(','), 'walls ms', set.map((r) => f(r.wallMs, 0)).join(' '), 'slope ms per cycle per repeat', slopes.map((s) => f(s, 3)).join(' '));
	}
}

console.log('\n# rung 6: spill of 64 MiB in 1 MiB extents');
{
	line('arm', 'op', 'n', 'wall ms (each)', 'errors');
	for (const [k, rows] of [...by(clients(6), (r) => `${r.shape}|${r.op}`)].sort())
		line(k, rows.length, rows.map((r) => `${f(r.wallMs, 0)}${r.status === 200 ? '' : '!' + r.status}`).join(' '), rows.filter((r) => r.status !== 200).length);
}

console.log('\n# platform meter (durableObjectsPeriodicGroups, per class and minute)');
{
	line('class', 'minutes', 'max MiB', 'min MiB', 'rows written', 'rows read', 'cpu ms', 'exceeded');
	for (const [cls, rows] of [...by<any>(meter.rows ?? [], (r) => r.cls)].sort()) {
		const mem = rows.map((r) => r.maxMemoryBytes / 1048576);
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
