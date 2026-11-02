// usage: node arms-table.mjs DIR ; one fresh process per (arm, driver, session); median speedup over sessions
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
const cells = new Map();
const failed = new Set();
if (existsSync(`${dir}/failed.log`))
	for (const line of readFileSync(`${dir}/failed.log`, 'utf8').trim().split('\n')) {
		const [, arm, id] = line.split(' ');
		if (id) failed.add(`${id}|${arm}`);
	}
for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
	const m = f.match(/^(automatic|forced|explicit|inplace)-(.+)-(\d)\.jsonl$/);
	if (!m) continue;
	const [, arm, id] = m;
	const rows = readFileSync(`${dir}/${f}`, 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l))
		.filter((r) => r.kind === 'sample');
	const mine = rows.filter((r) => r.arm === arm);
	if (!mine.length) continue;
	const byRound = {};
	for (const r of rows) (byRound[r.round] ??= {})[r.arm] = r;
	const paired = mine.filter((r) => byRound[r.round]?.native);
	if (!paired.length) continue;
	const sp = med(paired.map((r) => byRound[r.round].native.wallMs / r.wallMs));
	const key = `${id}|${arm}`;
	const c = cells.get(key) ?? { sp: [], ok: true, n: 0 };
	c.sp.push(sp);
	c.ok &&= mine.every((r) => r.passed);
	c.n += mine.length;
	cells.set(key, c);
}
const ids = [...new Set([...cells.keys(), ...failed].map((k) => k.split('|')[0]))].sort();
const cell = (id, arm) => {
	const c = cells.get(`${id}|${arm}`);
	if (failed.has(`${id}|${arm}`)) return `${c ? med(c.sp).toFixed(2) + ' ' : ''}FAILED`;
	if (!c) return '-';
	return `${med(c.sp).toFixed(2)} (${c.sp.filter((x) => x > 1).length}/${c.sp.length})${c.ok ? '' : ' NOT EXACT'}`;
};
console.log('| driver | automatic | forced | explicit | inplace |');
console.log('| --- | --- | --- | --- | --- |');
for (const id of ids)
	console.log(
		`| ${id} | ${cell(id, 'automatic')} | ${cell(id, 'forced')} | ${cell(id, 'explicit')} | ${cell(id, 'inplace')} |`
	);
let winners = 0;
for (const id of ids) {
	const c = cells.get(`${id}|automatic`);
	if (c && med(c.sp) > 1 && c.sp.filter((x) => x > 1).length >= 2) winners++;
}
console.log(
	`\nautomatic winners (median above 1, at least 2 of 3 sessions above 1): ${winners} of ${ids.length}`
);
