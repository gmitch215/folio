import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) throw new Error('usage: affine-state-summary.ts RAW.jsonl...');
const rows = files
	.flatMap((file) => readFileSync(file, 'utf8').split('\n').filter(Boolean))
	.map((line) => JSON.parse(line) as Record<string, any>);

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const fixed = (value: number, digits = 1) => value.toFixed(digits);
const range = (values: number[], digits = 1) =>
	`${fixed(Math.min(...values), digits)}-${fixed(Math.max(...values), digits)}`;

const samples = rows.filter((r) => r.kind === 'sample');
const sessions = [...new Set(samples.map((r) => r.session as number))].sort();
const partA = new Set(rows.filter((r) => r.kind === 'discovery').map((r) => r.subject));

console.log('## Discovery (part A)\n');
console.log(
	'| subject | state bytes | parameter bytes | scratch bytes | factors | calls | ms per session |'
);
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const subject of partA) {
	const found = rows.filter((r) => r.kind === 'discovery' && r.subject === subject);
	const first = found[0]!;
	console.log(
		`| ${subject} | ${first.state} | ${first.params} | ${first.scratch} | ${first.factors.join(' + ')} | ${first.calls} | ${found.map((r) => fixed(r.ms)).join(', ')} |`
	);
}

console.log('\n## Wall time\n');
console.log(
	'Each cell is the median of the session medians in ms, then the range of the session medians. Speedup is serial over the arm, per session, then the median and range. The cpu ratio is the arm over serial.\n'
);
console.log(
	'| subject | MiB | arm | wall ms | speedup | cpu ratio | rounds | equal | tasks | mismatchAt | fallback MiB |'
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const keys = [...new Set(samples.map((r) => `${r.subject}|${r.mib}`))];
for (const group of keys) {
	const [subject, mib] = group.split('|');
	const mine = samples.filter((r) => `${r.subject}|${r.mib}` === group);
	const perSession = (arm: string, field: string) =>
		sessions.map((s) =>
			median(
				mine.filter((r) => r.arm === arm && r.session === s).map((r) => r[field] as number)
			)
		);
	const serial = perSession('serial', 'ms');
	const serialCpu = perSession('serial', 'cpuMs');
	for (const arm of [...new Set(mine.map((r) => r.arm as string))]) {
		const wall = perSession(arm, 'ms');
		const cpu = perSession(arm, 'cpuMs');
		const speed = wall.map((w, i) => serial[i]! / w);
		const ratio = cpu.map((c, i) => c / serialCpu[i]!);
		const armRows = mine.filter((r) => r.arm === arm);
		const first = armRows[0]!;
		console.log(
			`| ${subject} | ${mib} | ${arm} | ${fixed(median(wall))} (${range(wall)}) | ${fixed(median(speed), 2)} (${range(speed, 2)}) | ${fixed(median(ratio), 2)} (${range(ratio, 2)}) | ${armRows.length} | ${armRows.every((r) => r.equal)} | ${first.tasks ?? ''} | ${first.mismatchAt ?? ''} | ${first.fallbackBytes === undefined ? '' : fixed(first.fallbackBytes / 1048576, 2)} |`
		);
	}
}

console.log('\n## Load average (1 minute) at the start of each session\n');
for (const r of rows.filter((r) => r.kind === 'environment'))
	console.log(
		`- session ${r.session}: ${fixed(r.loadStart[0], 2)} on ${r.hardwareThreads} threads`
	);
