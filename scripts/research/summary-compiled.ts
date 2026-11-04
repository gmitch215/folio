import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// usage: summary-compiled.ts CERTIFICATE_DIRECTORY OUTPUT.json ; runs summary-probe.ts on the
// binary that summary-certify.ts wrote there, after checking its digest against the certificate
const [directory, output] = process.argv.slice(2);
if (!directory || !output)
	throw new Error('usage: summary-compiled.ts CERTIFICATE_DIRECTORY OUTPUT.json');
if (existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
const evidence = JSON.parse(readFileSync(join(directory, 'certificate.json'), 'utf8'));
const binary = resolve(directory, evidence.binary);
assert.equal(
	createHash('sha256').update(readFileSync(binary)).digest('hex'),
	evidence.evidence.moduleSha256
);
execFileSync(
	process.execPath,
	[new URL('./summary-probe.ts', import.meta.url).pathname, resolve(output)],
	{ env: { ...process.env, FOLIO_SUMMARY_BINARY: binary }, stdio: 'inherit' }
);
