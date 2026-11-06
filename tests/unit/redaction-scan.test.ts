import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { scanPaths, scanText } from '../../scripts/research/redaction-scan.ts';

// planted values are built at run time so this file passes its own scan
const host = ['demo', 'free'].join('-') + '.workers.dev';
const resourceId = ['50f2303b3c9b4fc9', '8b1b67888063a728'].join('');
const bearer = ['Bearer', 'abcdef0123456789xyz'].join(' ');
const homePath = ['', 'Users', 'demo', 'work'].join('/');

test('a planted identifier fails the scan with its rule name', () => {
	expect(scanText('a.json', `"url": "https://${host}/run"`).map((f) => f.rule)).toEqual([
		'workers.dev host'
	]);
	expect(scanText('a.json', `{"id": "${resourceId}"}`).map((f) => f.rule)).toEqual([
		'resource id'
	]);
	expect(scanText('a.log', `auth: ${bearer}`).map((f) => f.rule)).toEqual(['bearer token']);
	expect(scanText('a.log', `cwd ${homePath}`).map((f) => f.rule)).toEqual(['home path']);
});

test('a digest or an ordinary sentence is not reported', () => {
	expect(scanText('s.json', '"sha256": "fe5e899156f5179f8dd154b23bac4af7"')).toEqual([]);
	expect(scanText('n.md', 'Bearer tokens and the workers.dev subdomain are named here.')).toEqual(
		[]
	);
});

test('the scan reports the file and line and counts clean and binary files', () => {
	const root = mkdtempSync(join(tmpdir(), 'folio-scan-'));
	mkdirSync(join(root, 'sub'));
	writeFileSync(join(root, 'sub', 'bad.json'), `one\n{"id": "${resourceId}"}\n`);
	writeFileSync(join(root, 'clean.md'), 'nothing here\n');
	writeFileSync(join(root, 'blob.wasm'), Buffer.from([0, 97, 115, 109]));
	const result = scanPaths([root]);
	expect(result.files).toBe(2);
	expect(result.skippedBinary).toBe(1);
	expect(result.findings).toEqual([
		{ file: join(root, 'sub', 'bad.json'), line: 2, rule: 'resource id' }
	]);
});
