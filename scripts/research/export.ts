import assert from 'node:assert/strict';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { basename, join } from 'node:path';
import { summarizeResearch } from './analyze.ts';
import { digest } from './environment.ts';

/** Copies inputs into a study directory, summarizes every JSONL record that has samples and writes `manifest.json`. */
export function exportStudy(directory: string, inputs: string[]) {
	mkdirSync(directory, { recursive: true });
	for (const input of inputs) {
		const [source = '', name = basename(source)] = input.split(':');
		const target = join(directory, name);
		assert.ok(!existsSync(target), `refusing to overwrite ${target}`);
		copyFileSync(source, target);
	}
	for (const name of readdirSync(directory).filter((item) => item.endsWith('.jsonl'))) {
		const bytes = readFileSync(join(directory, name));
		const rows = bytes
			.toString()
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		if (rows.some((row) => row.kind === 'sample'))
			writeFileSync(
				join(
					directory,
					name === 'raw.jsonl'
						? 'summary.json'
						: name.replace(/\.jsonl$/, '.summary.json')
				),
				JSON.stringify(summarizeResearch(rows, digest(bytes)), null, 2) + '\n'
			);
	}
	assert.ok(existsSync(join(directory, 'README.md')), 'write the study README before exporting');
	const artifacts = readdirSync(directory)
		.filter((name) => name !== 'manifest.json' && statSync(join(directory, name)).isFile())
		.sort()
		.map((name) => {
			const data = readFileSync(join(directory, name));
			return { path: name, bytes: data.length, sha256: digest(data) };
		});
	writeFileSync(
		join(directory, 'manifest.json'),
		JSON.stringify({ schema: 'folio.study.v1', artifacts }, null, 2) + '\n'
	);
	return artifacts.length;
}

if (import.meta.main) {
	const [directory, ...inputs] = process.argv.slice(2);
	if (!directory) throw new Error('usage: export.ts STUDY_DIRECTORY [SOURCE[:NAME]...]');
	console.log(JSON.stringify({ artifacts: exportStudy(directory, inputs) }));
}
