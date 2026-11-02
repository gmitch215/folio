/** Markdown tables from sweeps-bench.ts raw files. Usage: COUNT STATES WALL... */
import { readFileSync } from 'node:fs';

const [countPath, statesPath, ...wallPaths] = process.argv.slice(2);
if (!countPath || !statesPath) throw new Error('usage: sweeps-summary.ts COUNT STATES WALL...');
const read = (path: string) =>
	readFileSync(path, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Record<string, any>)
		.filter((row) => row.kind !== 'environment');

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const fmt = (x: number, digits = 2) => x.toFixed(digits);

const sweeps = read(countPath).filter((row) => row.kind === 'sweep');
const dfa = new Set(['utf8flag', 'utf8dfa', 'csvquote', 'csvrows', 'base64ok', 'rle', 'lines']);

console.log('## Sweeps to the fixed point (sweep = pass, warm pre-pass included)\n');
console.log('| subject | input | MiB | K | guess | sweeps | loop passes | chunk runs | equal |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of sweeps)
	console.log(
		`| ${r.subject} | ${r.input} | ${r.bytes / 1048576} | ${r.k} | ${r.guess} ` +
			`| ${r.sweeps} | ${r.loopPasses} | ${r.chunkRuns} | ${r.equal} |`
	);

const allEqual = sweeps.every((r) => r.equal);
console.log(`\nEvery count equals the serial call: ${allEqual} (${sweeps.length} rows)\n`);

console.log('## Kill condition at K = 8, text-like input (DFA subjects)\n');
console.log('| subject | zero guess | warm guess | verdict |');
console.log('| --- | --- | --- | --- |');
for (const subject of [...dfa]) {
	const rows = sweeps.filter(
		(r) => r.subject === subject && r.input === 'text' && r.k === 8 && r.bytes === 1048576
	);
	const zero = rows.find((r) => r.guess === 'zero')?.sweeps;
	const warm = rows.find((r) => r.guess === 'warm')?.sweeps;
	const verdict =
		zero === undefined
			? 'missing'
			: zero <= 3
				? 'survives (zero guess <= 3)'
				: 'dead for this class';
	console.log(`| ${subject} | ${zero} | ${warm} | ${verdict} |`);
}

const states = read(statesPath).filter((row) => row.kind === 'states');
console.log('\n## Distinct end states over all start states, by segment length\n');
console.log('| subject | input | length | starts | distinct end states | encoding |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const r of states)
	console.log(
		`| ${r.subject} | ${r.input} | ${r.length} | ${r.starts} | ${r.distinctEnds} | ${r.note} |`
	);

for (const path of wallPaths) {
	const rows = read(path).filter((r) => r.kind === 'sample');
	if (!rows.length) continue;
	const sessions = [...new Set(rows.map((r) => r.session as number))].sort();
	const group = (r: Record<string, any>) => `${r.subject}|${r.input}|${r.bytes}`;
	const groups = [...new Set(rows.map(group))];
	console.log(
		`\n## Wall on TaskPool, 8 workers (${path.split('/').pop()}, sessions ${sessions.join(',')})\n`
	);
	console.log(
		'| subject | input | MiB | arm | sweeps | chunk runs | wall ms | speedup (range) |' +
			' cpu ratio | equal |'
	);
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const g of groups) {
		const mine = rows.filter((r) => group(r) === g);
		const serialWall = sessions.map((s) =>
			median(mine.filter((r) => r.session === s && r.arm === 'serial').map((r) => r.ms))
		);
		const serialCpu = sessions.map((s) =>
			median(mine.filter((r) => r.session === s && r.arm === 'serial').map((r) => r.cpuMs))
		);
		const arms = [...new Set(mine.map((r) => r.arm as string))];
		for (const arm of arms) {
			const armRows = mine.filter((r) => r.arm === arm);
			const wall = sessions.map((s) =>
				median(mine.filter((r) => r.session === s && r.arm === arm).map((r) => r.ms))
			);
			const cpu = sessions.map((s) =>
				median(mine.filter((r) => r.session === s && r.arm === arm).map((r) => r.cpuMs))
			);
			const speed = wall.map((w, i) => serialWall[i]! / w);
			const ratio = cpu.map((c, i) => c / serialCpu[i]!);
			const first = armRows[0] ?? {};
			const [subject, input, bytes] = g.split('|');
			const serial = arm === 'serial';
			const sweeps = serial ? '' : (first.passes ?? '');
			const chunks = serial ? '' : (first.chunkRuns ?? '');
			const range = `${fmt(median(speed))} (${fmt(Math.min(...speed))}-${fmt(Math.max(...speed))})`;
			console.log(
				`| ${subject} | ${input} | ${Number(bytes) / 1048576} | ${arm} | ${sweeps} | ${chunks} ` +
					`| ${fmt(median(wall), 1)} | ${serial ? '1.00' : range} ` +
					`| ${serial ? '1.00' : fmt(median(ratio))} | ${armRows.every((r) => r.equal)} |`
			);
		}
	}
}
