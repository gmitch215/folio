// usage: node summary-breakeven-table.mjs COLDSTART.json...
// calls after which the one-time cost is repaid by the saving of each call over the serial run:
// certification is probe plus checker, first use is the first call minus a steady call (pool start included)
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) throw new Error('usage: summary-breakeven-table.mjs COLDSTART.json...');
const rows = files
	.map((file) => JSON.parse(readFileSync(file, 'utf8')))
	.sort((a, b) => a.mib - b.mib);
const f = (value, digits = 2) => value.toFixed(digits);
console.log(
	'| MiB | probe ms | check ms | certification ms | first use ms | serial ms | steady ms | saving ms | break-even calls (certification) | break-even calls (with first use) |'
);
console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of rows) {
	const certification = r.probeMs + r.checkMs;
	const firstUse = r.firstCallMs - r.secondCallMs;
	const saving = r.serialMs - r.secondCallMs;
	const calls = (cost) => (saving > 0 ? f(cost / saving, 1) : 'never');
	console.log(
		`| ${r.mib} | ${f(r.probeMs)} | ${f(r.checkMs)} | ${f(certification)} | ${f(firstUse)} | ${f(r.serialMs)} | ${f(r.secondCallMs)} | ${f(saving)} | ${calls(certification)} | ${calls(certification + firstUse)} |`
	);
}
