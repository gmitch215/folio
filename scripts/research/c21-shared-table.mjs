// usage: node c21-shared-table.mjs DIR ; median speedup over native per session, then over sessions
import { readFileSync, readdirSync } from 'node:fs';
const dir = process.argv[2];
const variants = ['copy', 'shared', 'skip', 'inplace'];
const med = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const cells = new Map();
for (const f of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
	const m = f.match(/^(copy|shared|skip|inplace)-(.+)-n(\d+)-(\d+)\.jsonl$/);
	if (!m) continue;
	const [, variant, id, n] = m;
	const rows = readFileSync(`${dir}/${f}`, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line))
		.filter((row) => row.kind === 'sample');
	const mine = rows.filter((row) => row.arm === (variant === 'inplace' ? 'inplace' : 'explicit'));
	if (!mine.length) continue;
	const native = new Map(
		rows.filter((row) => row.arm === 'native').map((row) => [row.round, row])
	);
	const key = `${id}|${n}|${variant}`;
	const cell = cells.get(key) ?? { speedups: [], passed: true, load: [], phases: [], wall: [] };
	cell.speedups.push(med(mine.map((row) => native.get(row.round).wallMs / row.wallMs)));
	cell.passed &&= mine.every((row) => row.passed);
	cell.load.push(...mine.map((row) => row.load?.[0]).filter((x) => x !== undefined));
	cell.wall.push(...mine.map((row) => row.wallMs));
	cell.phases.push(...mine.map((row) => row.report?.phases).filter(Boolean));
	cells.set(key, cell);
}
const show = (cell) =>
	cell
		? `${med(cell.speedups).toFixed(2)} [${Math.min(...cell.speedups).toFixed(2)}-${Math.max(...cell.speedups).toFixed(2)}]${cell.passed ? '' : ' NOT EXACT'}`
		: '-';
console.log(`| program | n | ${variants.join(' | ')} | median load1 |`);
console.log(`| --- | ---: | ${variants.map(() => '---').join(' | ')} | ---: |`);
const keys = [...new Set([...cells.keys()].map((k) => k.split('|').slice(0, 2).join('|')))].sort();
for (const key of keys) {
	const [id, n] = key.split('|');
	const mine = variants.map((variant) => cells.get(`${key}|${variant}`));
	const loads = mine.flatMap((cell) => cell?.load ?? []);
	console.log(
		`| ${id} | ${n} | ${mine.map(show).join(' | ')} | ${loads.length ? med(loads).toFixed(1) : '-'} |`
	);
}
console.log('');
console.log(
	'Worker time by phase, median per round, summed over workers (ms), against the median wall (ms).'
);
console.log('');
console.log(
	'| program | n | variant | wall | restore | write | kernel | copy out | skipped MiB per task |'
);
console.log('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const key of keys) {
	const [id, n] = key.split('|');
	for (const variant of variants) {
		const cell = cells.get(`${key}|${variant}`);
		if (!cell?.phases.length) continue;
		const at = (field) => med(cell.phases.map((phase) => phase[field])).toFixed(1);
		const tasks = med(cell.phases.map((phase) => phase.tasks));
		const skipped = med(cell.phases.map((phase) => phase.skippedBytes)) / tasks / 1048576;
		console.log(
			`| ${id} | ${n} | ${variant} | ${med(cell.wall).toFixed(1)} | ${at('restoreMs')} | ${at('writeMs')} | ${at('bulkMs')} | ${at('copyMs')} | ${skipped.toFixed(1)} |`
		);
	}
}
