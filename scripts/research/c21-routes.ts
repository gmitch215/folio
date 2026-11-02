import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { iterationRoute, stackRoute } from '../../src/extract.ts';
import { specs } from './c21-kernels.ts';

// what the stack route and the iteration route say about each corpus module as built
const root = new URL('../../', import.meta.url).pathname;
const [dir = join(root, 'build/research/corpus/artifacts'), output] = process.argv.slice(2);
const manifest = JSON.parse(
	readFileSync(join(root, 'scripts/research/corpus-manifest.json'), 'utf8')
);
const rows: Record<string, unknown>[] = [];
const list = process.env.C21 ? specs.map((x) => ({ id: x.id })) : manifest.cases;
for (const kernel of list) {
	const file = join(dir, `${kernel.id}.wasm`);
	const bytes = new Uint8Array(readFileSync(file));
	const stack = stackRoute(bytes);
	const iteration = iterationRoute(bytes, stack);
	const wat = execFileSync('wasm2wat', ['--enable-all', file], {
		encoding: 'utf8',
		maxBuffer: 1 << 28
	});
	const start = /\(start (\$[\w.]+)\)/.exec(wat)?.[1];
	let startBody = '';
	if (start) {
		const at = wat.indexOf(`(func ${start} `);
		const end = wat.indexOf('\n  (func ', at + 1);
		startBody = wat
			.slice(at, end < 0 ? undefined : end)
			.split('\n')
			.slice(1)
			.map((x) => x.trim())
			.join(' ');
	}
	rows.push({
		id: kernel.id,
		start,
		startBody,
		stackEligible: stack.eligible,
		stackGlobal: stack.stack?.name,
		workerSet: stack.functions.length,
		recursive: stack.recursive.length,
		stackDiagnostics: stack.diagnostics,
		iterationEligible: iteration.eligible,
		iterationDiagnostics: iteration.diagnostics.slice(0, 4)
	});
}
const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
if (output) writeFileSync(output, text);
for (const r of rows as any[])
	console.log(
		r.id.padEnd(16),
		'start=' + r.start,
		'body=' + r.startBody,
		'| stack ok=' + r.stackEligible,
		'set=' + r.workerSet,
		'| iter ok=' + r.iterationEligible
	);
