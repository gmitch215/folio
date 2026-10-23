import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { summarizeRun } from './hostboot-analyze.ts';

const [directory, out] = process.argv.slice(2);
if (!directory || !out) throw new Error('usage: hostboot-report.ts <run directory> <output json>');
const read = (file: string) => readFileSync(`${directory}/${file}`, 'utf8');
const tails = Object.fromEntries(
	readdirSync(directory)
		.filter((file) => /^tail-.*\.jsonl$/.test(file))
		.map((file) => [file.slice(5, -6), read(file)])
);
const summary = {
	...(existsSync(`${directory}/summary.json`) ? JSON.parse(read('summary.json')) : {}),
	...summarizeRun(JSON.parse(read('steps.json')), tails)
};
const text = JSON.stringify(summary, null, 2).replace(/[a-z0-9-]+\.workers\.dev/g, '<host>');
writeFileSync(out, `${text}\n`);
console.log(text);
