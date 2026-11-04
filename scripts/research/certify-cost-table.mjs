// usage: node certify-cost-table.mjs COST.json...
// calls after which the one-time cost is repaid by the saving of a steady call over the serial call.
// Records with the same subject, size and worker count are pooled: samples are concatenated and the
// single-sample costs are medians over the records
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) throw new Error('usage: certify-cost-table.mjs COST.json...');
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const f = (value, digits = 2) => value.toFixed(digits);
const groups = new Map();
for (const file of files) {
	const r = JSON.parse(readFileSync(file, 'utf8'));
	const key = `${r.subject}|${r.mib}|${r.width}`;
	if (!groups.has(key)) groups.set(key, []);
	groups.get(key).push(r);
}
console.log(
	'| Subject | MiB | Workers | Records | certify ms | prepare and compile ms | pool start ms | serial ms | steady ms | saving ms | speedup (sessions) | CPU ratio | break-even calls (certify) | break-even calls (all) |'
);
console.log(
	'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
);
const order = [...groups.values()].sort(
	(a, b) => a[0].subject.localeCompare(b[0].subject) || a[0].mib - b[0].mib
);
for (const records of order) {
	const [r] = records;
	const certify = median(records.flatMap((x) => x.certifyMs));
	const prepare = median(records.map((x) => x.prepareMs + x.compileMs));
	const steady = median(records.flatMap((x) => x.steadyMs));
	const serial = median(records.flatMap((x) => x.serialMs));
	const start = Math.max(0, median(records.map((x) => x.firstCallMs)) - steady);
	const saving = serial - steady;
	const calls = (cost) => (saving > 0 ? f(cost / saving, 1) : 'never');
	// each record is one session: its serial median over its steady median
	const each = records.map((x) => median(x.serialMs) / median(x.steadyMs)).sort((a, b) => a - b);
	const speed = `${f(median(each))}x (${f(each[0])} to ${f(each[each.length - 1])})`;
	// records from before the CPU time was recorded have none
	const withCpu = records.filter((x) => x.cpuSteadyMs !== undefined);
	const cpu = withCpu.length
		? f(median(withCpu.map((x) => x.cpuSteadyMs)) / median(withCpu.map((x) => x.cpuSerialMs)))
		: '-';
	console.log(
		`| ${r.subject} | ${r.mib} | ${r.width} | ${records.length} | ${f(certify)} | ${f(prepare)} | ${f(start)} | ${f(serial)} | ${f(steady)} | ${f(saving)} | ${speed} | ${cpu} | ${calls(certify)} | ${calls(certify + prepare + start)} |`
	);
}
