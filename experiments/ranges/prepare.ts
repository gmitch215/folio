import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prepare } from '../../src/compiler.ts';
import { inlineLane } from '../../src/inline.ts';
import { memoryImports } from '../../src/memory.ts';
import { helperSource, kernelSource } from './kernel.ts';

const root = new URL('./build/', import.meta.url);
mkdirSync(root, { recursive: true });
const source = kernelSource();
const program = prepare(source, { minimumRegionWork: 0 });
assert.ok(program.control);
const { coordinator, transactional, workerOriginal, ...control } = program.control;
writeFileSync(new URL('original.wasm', root), source);
writeFileSync(new URL('coordinator.wasm', root), coordinator);
writeFileSync(new URL('transactional.wasm', root), transactional);
writeFileSync(new URL('inline.wasm', root), inlineLane(workerOriginal));
writeFileSync(new URL('helpers.wasm', root), helperSource());
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
		"import inline from './build/inline.wasm';",
		"import helpers from './build/helpers.wasm';",
		'export const metadata: Required<Pick<ManagedArtifact, "control" | "memories">> & {',
		'\tsourceSha256: string;',
		`} = ${JSON.stringify(metadata)};`,
		'export { helpers };',
		'export default { original, coordinator, transactional, inline, ...metadata } satisfies ManagedArtifact;',
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
