import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { prepare } from '../../src/compiler.ts';
import { memoryImports } from '../../src/memory.ts';

const root = new URL('./build/', import.meta.url);
mkdirSync(root, { recursive: true });
const source = readFileSync(new URL('../../build/generalized.wasm', import.meta.url));
const program = prepare(source);
assert.ok(program.control);
const { coordinator, transactional, workerOriginal: _, ...control } = program.control;
writeFileSync(new URL('original.wasm', root), source);
writeFileSync(new URL('coordinator.wasm', root), coordinator);
writeFileSync(new URL('transactional.wasm', root), transactional);
const metadata = {
	control,
	memories: memoryImports(source),
	sourceSha256: createHash('sha256').update(source).digest('hex')
};
writeFileSync(new URL('metadata.json', root), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(
	new URL('./artifact.ts', import.meta.url),
	[
		"import type { ManagedArtifact } from '../../src/managed.ts';",
		"import original from './build/original.wasm';",
		"import coordinator from './build/coordinator.wasm';",
		"import transactional from './build/transactional.wasm';",
		'export const metadata: Required<Pick<ManagedArtifact, "control" | "memories">> & {',
		'\tsourceSha256: string;',
		`} = ${JSON.stringify(metadata)};`,
		'export default { original, coordinator, transactional, ...metadata } satisfies ManagedArtifact;',
		''
	].join('\n')
);
console.log(
	JSON.stringify({
		originalBytes: source.length,
		regions: control.regions.length,
		entries: control.entries,
		sourceSha256: metadata.sourceSha256
	})
);
