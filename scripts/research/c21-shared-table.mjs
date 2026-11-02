// usage: node c21-shared-table.mjs DIR ; median speedup over native per session, then over sessions
import { readFileSync, readdirSync } from 'node:fs';
const dir = process.argv[2];
const med = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const cells = new Map();
for (const f of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
	const m = f.match(/^(copy|shared)-(.+)-n(\d+)-(\d+)\.jsonl$/);
	if (!m) continue;
	const [, variant, id, n] = m;
	const rows = readFileSync(`${dir}/${f}`, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
		.filter((row) => row.kind === 'sample');
	const mine = rows.filter((row) => row.arm === 'explicit');
	if (!mine.length) continue;
	const native = new Map(
		rows.filter((row) => row.arm === 'native').map((row) => [row.round, row])
	);
	const key = `${id}|${n}|${variant}`;
	const cell = cells.get(key) ?? { speedups: [], passed: true, load: [] };
	cell.speedups.push(med(mine.map((row) => native.get(row.round).wallMs / row.wallMs)));
	cell.passed &&= mine.every((row) => row.passed);
	cell.load.push(...mine.map((row) => row.load?.[0]).filter((x) => x !== undefined));
	cells.set(key, cell);
}
const show = (cell) =>
	cell
		? `${med(cell.speedups).toFixed(2)} [${Math.min(...cell.speedups).toFixed(2)}-${Math.max(...cell.speedups).toFixed(2)}]${cell.passed ? '' : ' NOT EXACT'}`
		: '-';
console.log('| program | n | copy | shared | median load1 |');
console.log('| --- | ---: | --- | --- | ---: |');
const keys = [...new Set([...cells.keys()].map((k) => k.split('|').slice(0, 2).join('|')))].sort();
for (const key of keys) {
	const [id, n] = key.split('|');
	const copy = cells.get(`${key}|copy`);
	const shared = cells.get(`${key}|shared`);
	const loads = [...(copy?.load ?? []), ...(shared?.load ?? [])];
	console.log(
		`| ${id} | ${n} | ${show(copy)} | ${show(shared)} | ${loads.length ? med(loads).toFixed(1) : '-'} |`
	);
}
