import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { prepare } from '../../src/compiler.ts';
import { memoryImports } from '../../src/memory.ts';
import { drivers } from './drivers.ts';
import { syntheticSource } from './synthetic.ts';

// node experiments/corpus-lanes/prepare.ts [id ...]: builds and pins the driver artifacts. The
// corpus drivers come from build/research/<FOLIO_CORPUS_DRIVERS ?? x1>; synthetic-sum needs none.
const root = new URL('./build/', import.meta.url);
mkdirSync(root, { recursive: true });
const from = new URL(
	`../../build/research/${process.env.FOLIO_CORPUS_DRIVERS ?? 'x1'}/`,
	import.meta.url
);
const wanted = process.argv.slice(2);
const ids = wanted.length ? wanted : drivers.map((d) => d.id);
const built: Record<string, unknown> = {};
for (const id of ids) {
	let source: Uint8Array;
	if (id === 'synthetic-sum') source = syntheticSource();
	else {
		const file = new URL(`${id}.wasm`, from);
		if (!existsSync(file)) {
			console.log(
				JSON.stringify({ id, skipped: 'driver module not built', path: file.pathname })
			);
			continue;
		}
		source = new Uint8Array(readFileSync(file));
	}
	const program = prepare(source, { minimumRegionWork: 0 });
	assert.ok(program.control, `${id}: no control plan`);
	const { coordinator, transactional, workerOriginal: _, ...control } = program.control;
	writeFileSync(new URL(`${id}.original.wasm`, root), source);
	writeFileSync(new URL(`${id}.coordinator.wasm`, root), coordinator);
	writeFileSync(new URL(`${id}.transactional.wasm`, root), transactional);
	built[id] = {
		control,
		memories: memoryImports(source),
		sourceSha256: createHash('sha256').update(source).digest('hex')
	};
}
const present = Object.keys(built);
writeFileSync(new URL('metadata.json', root), `${JSON.stringify(built, null, 2)}\n`);
const imports = present.flatMap((id, index) => [
	`import original${index} from './build/${id}.original.wasm';`,
	`import coordinator${index} from './build/${id}.coordinator.wasm';`,
	`import transactional${index} from './build/${id}.transactional.wasm';`
]);
const entries = present.map(
	(id, index) =>
		`\t${JSON.stringify(id)}: { original: original${index}, coordinator: coordinator${index}, transactional: transactional${index}, ...metadata[${JSON.stringify(id)}]! }`
);
writeFileSync(
	new URL('./artifact.ts', import.meta.url),
	[
		"import type { ManagedArtifact } from '../../src/managed.ts';",
		...imports,
		`const metadata: Record<string, Required<Pick<ManagedArtifact, 'control' | 'memories'>> & { sourceSha256: string }> = ${JSON.stringify(built)};`,
		'export const artifacts: Record<string, ManagedArtifact & { sourceSha256: string }> = {',
		entries.join(',\n'),
		'};',
		''
	].join('\n')
);
console.log(JSON.stringify({ built: present }));
