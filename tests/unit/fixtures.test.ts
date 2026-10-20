import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { buildFixtures } from '../../scripts/build/fixtures.ts';

const digest = (files: string[]) =>
	files.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'));

test('fixture bytes do not depend on a wasm-opt in node_modules/.bin', () => {
	const out = mkdtempSync(join(tmpdir(), 'folio-fixtures-'));
	const path = process.env.PATH;
	try {
		const before = digest(buildFixtures(join(out, 'plain')));
		process.env.PATH = `${join(process.cwd(), 'node_modules/.bin')}:${path}`;
		assert.deepEqual(digest(buildFixtures(join(out, 'polluted'))), before);
	} finally {
		process.env.PATH = path;
		rmSync(out, { recursive: true, force: true });
	}
});
