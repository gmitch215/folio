import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export interface EvidenceRecord {
	path: string;
	origin: string;
	bytes: number;
	sha256: string;
}

/** Verifies recorded artifact bytes and confines every indexed path to the evidence tree. */
export function verifyEvidence(root: string, records: readonly EvidenceRecord[]) {
	const seen = new Set<string>();
	const evidenceRoot = realpathSync(join(root, 'results')) + sep;
	let bytes = 0;
	for (const item of records) {
		const path = resolve(root, item.path);
		assert.ok(path.startsWith(resolve(root, 'results') + sep), 'evidence path escapes results');
		assert.ok(realpathSync(path).startsWith(evidenceRoot), 'evidence symlink escapes results');
		assert.ok(!seen.has(path), `duplicate evidence: ${item.path}`);
		seen.add(path);
		const data = readFileSync(path);
		assert.equal(data.length, item.bytes, `evidence length: ${item.path}`);
		assert.equal(
			createHash('sha256').update(data).digest('hex'),
			item.sha256,
			`evidence hash: ${item.path}`
		);
		assert.ok(existsSync(join(path, '..', 'README.md')), `missing study README: ${item.path}`);
		bytes += data.length;
	}
	return { artifacts: records.length, bytes };
}

/** Verifies every study manifest under results: listed bytes and hashes, confined paths, a README. */
export function verifyStudies(root: string) {
	const results = realpathSync(join(root, 'results'));
	let studies = 0,
		artifacts = 0,
		bytes = 0;
	const visit = (directory: string) => {
		for (const name of readdirSync(directory).sort()) {
			const file = join(directory, name);
			if (statSync(file).isDirectory()) visit(file);
			else if (name === 'manifest.json' || name === 'artifacts.json') {
				const manifest = JSON.parse(readFileSync(file, 'utf8'));
				if (!/^folio\.study(-artifacts)?\.v1$/.test(manifest.schema)) continue;
				assert.ok(
					existsSync(join(directory, 'README.md')),
					`missing study README: ${file}`
				);
				const study = realpathSync(directory) + sep;
				assert.ok(study.startsWith(results + sep), `study escapes results: ${file}`);
				const seen = new Set<string>();
				for (const item of manifest.artifacts as Omit<EvidenceRecord, 'origin'>[]) {
					const path = resolve(directory, item.path);
					assert.ok(
						realpathSync(path).startsWith(study),
						`artifact escapes study: ${item.path}`
					);
					assert.ok(!seen.has(path), `duplicate artifact: ${item.path}`);
					seen.add(path);
					const data = readFileSync(path);
					assert.equal(data.length, item.bytes, `artifact length: ${file} ${item.path}`);
					assert.equal(
						createHash('sha256').update(data).digest('hex'),
						item.sha256,
						`artifact hash: ${file} ${item.path}`
					);
					artifacts++;
					bytes += data.length;
				}
				studies++;
			}
		}
	};
	visit(results);
	return { studies, artifacts, bytes };
}

if (import.meta.main) {
	const root = new URL('../../', import.meta.url).pathname;
	const index = JSON.parse(readFileSync(join(root, 'results/index.json'), 'utf8'));
	console.log(JSON.stringify(verifyEvidence(root, index.artifacts)));
	console.log(JSON.stringify(verifyStudies(root)));
	if (process.argv.includes('--summaries')) {
		const temporary = mkdtempSync(join(tmpdir(), 'folio-evidence-'));
		cpSync(join(root, 'results'), temporary, { recursive: true });
		execFileSync(process.execPath, ['scripts/analyze/run.ts'], {
			cwd: root,
			env: { ...process.env, FOLIO_RESULTS_ROOT: temporary },
			stdio: 'pipe'
		});
		let checked = 0;
		const visit = (directory: string) => {
			for (const name of readdirSync(directory)) {
				const file = join(directory, name);
				if (statSync(file).isDirectory()) visit(file);
				else if (name.endsWith('summary.json')) {
					const original = join(root, 'results', file.slice(temporary.length + 1));
					assert.deepEqual(
						readFileSync(file),
						readFileSync(original),
						`regenerated summary differs: ${original}`
					);
					checked++;
				}
			}
		};
		visit(temporary);
		console.log(JSON.stringify({ summariesCompared: checked }));
	}
}
