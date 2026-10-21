import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { memoryImports } from '../../../src/memory.ts';
import { bundleFit } from '../plan.ts';

const root = new URL('../../../', import.meta.url);
const out = new URL('../build/php/', import.meta.url);
const consumer = process.env.FOLIO_CONSUMER ?? new URL('../../drupflare/worker', root).pathname;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Stages the original PHP module, its glue and the four-module prepared set from the sibling checkouts. */
export function stage() {
	mkdirSync(out, { recursive: true });
	const original = readFileSync(join(consumer, '.interp/php8.5.tuned.wasm'));
	const prepared = deserialize(readFileSync(new URL('build/php-prepared.bin', root))) as {
		original: Uint8Array;
		control: { coordinator: Uint8Array; workerOriginal: Uint8Array; transactional: Uint8Array };
	};
	assert.equal(
		sha256(prepared.original),
		sha256(original),
		'prepared plan is for another artifact'
	);
	const wasm = (name: string, bytes: Uint8Array) => {
		writeFileSync(new URL(`${name}.wasm`, out), bytes);
		return { bytes: bytes.length, sha256: sha256(bytes), memories: memoryImports(bytes) };
	};
	const modules = {
		original: wasm('php', original),
		coordinator: wasm('coordinator', prepared.control.coordinator),
		lane: wasm('lane', prepared.control.workerOriginal),
		tracked: wasm('tracked', prepared.control.transactional)
	};
	writeFileSync(new URL('modules.json', out), JSON.stringify(modules, null, '\t'));
	copyFileSync(join(consumer, '.interp/php8.5-worker.tuned.mjs'), new URL('glue.mjs', out));
	for (const file of [
		'PhpBase.mjs',
		'OutputBuffer.mjs',
		'_Event.mjs',
		'fsOps.mjs',
		'resolveDependencies.mjs'
	])
		copyFileSync(join(consumer, 'node_modules/php-wasm', file), new URL(file, out));
	const glue = statSync(new URL('glue.mjs', out)).size;
	const sizes = {
		original: bundleFit({ original: modules.original.bytes, glue }),
		prepared: bundleFit({
			original: modules.original.bytes,
			coordinator: modules.coordinator.bytes,
			lane: modules.lane.bytes,
			tracked: modules.tracked.bytes,
			glue
		})
	};
	return { modules, glueBytes: glue, sizes };
}

if (import.meta.main) {
	const { modules, sizes } = stage();
	console.log(
		JSON.stringify({
			bytes: Object.fromEntries(
				Object.entries(modules).map(([name, value]) => [name, value.bytes])
			),
			originalBundle: sizes.original,
			preparedBundle: sizes.prepared
		})
	);
}
