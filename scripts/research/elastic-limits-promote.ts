import assert from 'node:assert/strict';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { digest } from './environment.ts';
import { writeManifest } from './export.ts';

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// module identifiers become ordinals in order of first appearance, so equality survives
export function redactIsolates(text: string) {
	const seen = new Map<string, string>();
	const out = text.replace(uuid, (id) => {
		const key = id.toLowerCase();
		if (!seen.has(key)) seen.set(key, `isolate-${seen.size}`);
		return seen.get(key)!;
	});
	return { text: out, isolates: seen.size };
}

// the account listing keeps its class names and loses the resource ids
export function reduceNamespaces(list: { id: string; cls: string }[]) {
	return { count: list.length, classes: list.map((row) => row.cls) };
}

const carried = [
	'budget.json',
	'cleanup.json',
	'counters.json',
	'meter.json',
	'meter-unlisted.json',
	'source.json'
];

// copies one run into a study directory; raw lines and the namespace listing are redacted
export function promoteRun(study: string, source: string, name: string) {
	const target = join(study, name);
	mkdirSync(target, { recursive: true });
	for (const file of carried)
		if (existsSync(join(source, file))) copyFileSync(join(source, file), join(target, file));
	const entries = [];
	const raw = readFileSync(join(source, 'raw.jsonl'));
	const redacted = redactIsolates(raw.toString('utf8'));
	writeFileSync(join(target, 'raw.jsonl'), redacted.text);
	entries.push({
		file: `${name}/raw.jsonl`,
		originalBytes: raw.length,
		originalSha256: digest(raw),
		isolatesReplaced: redacted.isolates
	});
	// the first run predates the namespace listing
	if (existsSync(join(source, 'namespaces.json'))) {
		const namespaces = readFileSync(join(source, 'namespaces.json'));
		const reduced = reduceNamespaces(JSON.parse(namespaces.toString('utf8')));
		writeFileSync(join(target, 'namespaces.json'), JSON.stringify(reduced, null, 2) + '\n');
		entries.push({
			file: `${name}/namespaces.json`,
			originalBytes: namespaces.length,
			originalSha256: digest(namespaces),
			counts: reduced.count
		});
	}
	return entries;
}

// copies the harness sources of one version, without its tests and notes
export function promoteSource(study: string, source: string, name: string) {
	const target = join(study, 'source', name);
	mkdirSync(target, { recursive: true });
	const files = readdirSync(source)
		.filter((file) => /\.(ts|mjs)$/.test(file) && !file.endsWith('.test.ts'))
		.concat('tsconfig.json')
		.sort();
	for (const file of files) copyFileSync(join(source, file), join(target, file));
	return files.length;
}

if (import.meta.main) {
	const [study, ...rest] = process.argv.slice(2);
	assert.ok(
		study,
		'usage: elastic-limits-promote.ts STUDY_DIR [RUN_DIR:NAME | --source DIR:NAME]...'
	);
	const files = [];
	let sources = 0;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === '--source') {
			const [dir = '', name = ''] = (rest[++i] ?? '').split(':');
			sources += promoteSource(study, dir, name);
		} else {
			const [dir = '', name = ''] = (rest[i] ?? '').split(':');
			files.push(...promoteRun(study, dir, name));
		}
	}
	if (files.length)
		writeFileSync(
			join(study, 'redaction.json'),
			JSON.stringify(
				{
					note: 'module identifiers in raw.jsonl became ordinals; the namespace listings became counts; the originals are not promoted',
					files
				},
				null,
				2
			) + '\n'
		);
	console.log(
		JSON.stringify({ redacted: files.length, sources, artifacts: writeManifest(study, true) })
	);
}
