import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ['php8.5-worker.mjs', 'php8.5-worker.mjs.wasm'];

// Copies the i5b artifact from FOLIO_PHP_WASM_DIR/i5b into the ignored build/ and checks its hash.
export function prepareBuild() {
	const root = process.env.FOLIO_PHP_WASM_DIR;
	if (!root) throw new Error('set FOLIO_PHP_WASM_DIR to the directory that holds i5b/');
	const build = join(here, 'build');
	mkdirSync(build, { recursive: true });
	for (const f of FILES) copyFileSync(join(root, 'i5b', f), join(build, f));
	const wasmSha = createHash('sha256')
		.update(readFileSync(join(build, FILES[1])))
		.digest('hex');
	const glueSha = createHash('sha256')
		.update(readFileSync(join(build, FILES[0])))
		.digest('hex');
	if (!wasmSha.startsWith('9031f413'))
		throw new Error(`wasm sha256 ${wasmSha} is not 9031f413...`);
	return { build, wasmSha, glueSha };
}
