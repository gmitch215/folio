import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { summarizeRun } from './s34-analyze.ts';

const [directory, out] = process.argv.slice(2);
if (!directory || !out) throw new Error('usage: s34-report.ts <run directory> <output json>');
const read = (file: string) => readFileSync(`${directory}/${file}`, 'utf8');
const summary = {
	...(existsSync(`${directory}/summary.json`) ? JSON.parse(read('summary.json')) : {}),
	...summarizeRun(JSON.parse(read('steps.json')), {
		control: read('tail-control.jsonl'),
		baked: read('tail-baked.jsonl')
	})
};
const text = JSON.stringify(summary, null, 2).replace(/[a-z0-9-]+\.workers\.dev/g, '<host>');
writeFileSync(out, `${text}\n`);
console.log(text);
