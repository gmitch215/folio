// usage: node summary-onepass-table.mjs CELLS_DIR [SUMMARY.json]
// median over sessions of the per-session paired medians, per width and size; SUMMARY.json must not exist
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, target] = process.argv.slice(2);
if (!dir) throw new Error('usage: summary-onepass-table.mjs CELLS_DIR [SUMMARY.json]');
if (target && existsSync(target)) throw new Error(`refusing to overwrite ${target}`);
const median = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const cells = new Map();
for (const file of readdirSync(dir).filter((f) => /^s\d-m\d+-w\d+\.json$/.test(f))) {
	const [, session, mib, width] = file.match(/^s(\d)-m(\d+)-w(\d+)\.json$/);
	const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
	const byRound = new Map();
	for (const row of data.rows) {
		if (!byRound.has(row.round)) byRound.set(row.round, {});
		byRound.get(row.round)[row.arm] = row;
	}
	const ratios = {};
	for (const round of byRound.values()) {
		if (!round.serial) continue;
		for (const [arm, row] of Object.entries(round)) {
			ratios[arm] ??= { speed: [], cpu: [], wall: [] };
			ratios[arm].speed.push(round.serial.wallMs / row.wallMs);
			ratios[arm].cpu.push(row.cpuMs / round.serial.cpuMs);
			ratios[arm].wall.push(row.wallMs);
		}
	}
	const key = `${mib}:${width}`;
	if (!cells.has(key)) cells.set(key, { mib: Number(mib), width: Number(width), sessions: {} });
	cells.get(key).sessions[session] = Object.fromEntries(
		Object.entries(ratios).map(([arm, r]) => [
			arm,
			{
				speed: median(r.speed),
				cpu: median(r.cpu),
				wallMs: median(r.wall),
				n: r.speed.length
			}
		])
	);
}
const table = [];
for (const cell of [...cells.values()].sort((a, b) => a.mib - b.mib || a.width - b.width)) {
	const arms = {};
	for (const arm of ['one-shared', 'one-copy', 'two-shared']) {
		const per = Object.values(cell.sessions)
			.map((s) => s[arm])
			.filter(Boolean);
		if (!per.length) continue;
		arms[arm] = {
			speed: Number(median(per.map((p) => p.speed)).toFixed(2)),
			cpu: Number(median(per.map((p) => p.cpu)).toFixed(2)),
			sessions: per.length,
			speedRange: [
				Number(Math.min(...per.map((p) => p.speed)).toFixed(2)),
				Number(Math.max(...per.map((p) => p.speed)).toFixed(2))
			]
		};
	}
	const serial = Object.values(cell.sessions)
		.map((s) => s.serial?.wallMs)
		.filter(Boolean);
	table.push({
		mib: cell.mib,
		width: cell.width,
		serialMs: Number(median(serial).toFixed(1)),
		...arms
	});
}
if (target) writeFileSync(target, JSON.stringify(table, null, 2) + '\n');
for (const r of table) {
	const mbps = Math.round(((r.mib * 1.048576) / r.serialMs) * 1000);
	console.log(
		`${r.mib} MiB w${r.width} serial ${r.serialMs} ms (${mbps} MB/s) | one-shared ${r['one-shared']?.speed}x cpu ${r['one-shared']?.cpu} range ${r['one-shared']?.speedRange?.join('-')} | one-copy ${r['one-copy']?.speed}x cpu ${r['one-copy']?.cpu} | two-shared ${r['two-shared']?.speed ?? '-'}x cpu ${r['two-shared']?.cpu ?? '-'}`
	);
}
