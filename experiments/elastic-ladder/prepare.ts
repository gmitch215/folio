import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureLz4 } from './lz4-build.ts';
import { buildTraceWasm } from './trace-build.ts';

const here = new URL('.', import.meta.url);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixture = new URL(
	'../../results/execution/elastic-memory/managed-envelope/source/fixture.wasm',
	here
);

const build = new URL('build/', here);
mkdirSync(build, { recursive: true });
copyFileSync(fixture, new URL('fixture.wasm', build));
ensureLz4();
writeFileSync(new URL('trace.wasm', build), buildTraceWasm());
console.log(
	JSON.stringify({
		fixture: sha(readFileSync(new URL('fixture.wasm', build))),
		lz4: sha(readFileSync(new URL('lz4.wasm', build))),
		trace: sha(readFileSync(new URL('trace.wasm', build)))
	})
);
