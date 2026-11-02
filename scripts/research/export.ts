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
	return writeManifest(directory);
}

/** Lists the files of a study directory with bytes and hashes and writes `manifest.json`. Subdirectories are listed with a relative path when `recursive` is set. */
export function writeManifest(directory: string, recursive = false) {
	assert.ok(existsSync(join(directory, 'README.md')), 'write the study README before exporting');
	const list = (relative: string): string[] =>
		readdirSync(join(directory, relative)).flatMap((name) => {
			const path = relative ? `${relative}/${name}` : name;
			const directoryEntry = statSync(join(directory, path)).isDirectory();
			if (directoryEntry) return recursive ? list(path) : [];
			return path === 'manifest.json' ? [] : [path];
		});
	const artifacts = list('')
		.sort()
		.map((path) => {
			const data = readFileSync(join(directory, path));
			return { path, bytes: data.length, sha256: digest(data) };
		});
	writeFileSync(
		join(directory, 'manifest.json'),
		JSON.stringify({ schema: 'folio.study.v1', artifacts }, null, 2) + '\n'
	);
	return artifacts.length;
}

if (import.meta.main) {
	const [first, ...rest] = process.argv.slice(2);
	if (first === '--manifest') {
		const [directory, recursive] = rest;
		if (!directory)
			throw new Error('usage: export.ts --manifest STUDY_DIRECTORY [--recursive]');
		console.log(
			JSON.stringify({ artifacts: writeManifest(directory, recursive === '--recursive') })
		);
	} else {
		if (!first) throw new Error('usage: export.ts STUDY_DIRECTORY [SOURCE[:NAME]...]');
		console.log(JSON.stringify({ artifacts: exportStudy(first, rest) }));
	}
}
