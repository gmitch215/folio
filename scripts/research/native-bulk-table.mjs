// usage: node native-bulk-table.mjs DIR ; one JSON line per (driver, session) from native-bulk-arms.sh
import { existsSync, readFileSync, readdirSync } from 'node:fs';
const dir = process.argv[2];
const med = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length
		? s.length % 2
			? s[(s.length - 1) / 2]
			: (s[s.length / 2 - 1] + s[s.length / 2]) / 2
		: NaN;
};
const failed = new Set();
if (existsSync(`${dir}/failed.log`))
	for (const line of readFileSync(`${dir}/failed.log`, 'utf8').trim().split('\n')) {
		const [, id] = line.split(' ');
		if (id) failed.add(id);
	}
const cells = new Map();
for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
	const m = f.match(/^(.+)-(\d+)\.jsonl$/);
	if (!m) continue;
	const text = readFileSync(`${dir}/${f}`, 'utf8').trim();
	if (!text) continue;
	const row = JSON.parse(text.split('\n')[0]);
	const c = cells.get(m[1]) ?? { rows: [] };
	c.rows.push(row);
	cells.set(m[1], c);
}
const ids = [...new Set([...cells.keys(), ...failed])].sort();
console.log(
	'| driver | n | threads | serial ms | parallel ms | speedup (range over sessions) | equal |'
);
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const id of ids) {
	const rows = cells.get(id)?.rows ?? [];
	if (!rows.length) {
		console.log(`| ${id} | - | - | - | - | - | FAILED |`);
		continue;
	}
	const sp = rows.map((r) => r.serialMs / r.parallelMs);
	const equal = rows.every((r) => r.equal) ? 'yes' : 'NO';
	const note = failed.has(id) ? ' (some sessions FAILED)' : '';
	console.log(
		`| ${id} | ${rows[0].n} | ${rows[0].threads} | ${med(rows.map((r) => r.serialMs)).toFixed(3)} | ${med(rows.map((r) => r.parallelMs)).toFixed(3)} | ${med(sp).toFixed(2)} (${Math.min(...sp).toFixed(2)} to ${Math.max(...sp).toFixed(2)}, ${rows.length} sessions) | ${equal}${note} |`
	);
}
