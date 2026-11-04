import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

// generators with ground truth and both spike checkers, then the merge and the counts
const dir = process.argv[2];
if (!dir) throw new Error('usage: run.ts OUTPUT_DIRECTORY');
if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
const here = new URL('./', import.meta.url).pathname;
for (const step of [
	'gen-ops',
	'gen-wrapper',
	'gen-loopstate',
	'gen-raw',
	'gen-c',
	'summarize',
	'counts'
]) {
	console.log(`== ${step}`);
	execFileSync(process.execPath, [`${here}${step}.ts`, dir], { stdio: 'inherit' });
}
