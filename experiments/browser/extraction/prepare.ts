import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { prepare } from '../../../src/compiler.ts';
import { memoryImports } from '../../../src/memory.ts';

/** Builds browser-native assets with the repository's pinned TypeScript and Binaryen tooling. */
export function browserExtractionAssets() {
	const fixture = readFileSync(new URL('../../../build/fixture.wasm', import.meta.url));
	const { loops, native, reasons } = prepare(fixture);
	assert.equal(reasons.length, 0);
	assert.ok(loops.program && native?.program);
	const compile = (path: string) =>
		ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
		}).outputText;
	return {
		'/browser.js': ['application/javascript', compile('../../../src/browser.ts')],
		'/extraction-lane.js': [
			'application/javascript',
			compile('../../../src/browser-worker.ts')
		],
		'/extraction.js': [
			'application/javascript',
			compile('./probe.ts').replace("'../../../src/browser.ts'", "'/browser.js'")
		],
		'/extraction.json': [
			'application/json',
			JSON.stringify({ loops, native, reasons, memories: memoryImports(fixture) })
		],
		'/fixture.wasm': ['application/wasm', fixture],
		'/arena': [
			'text/html',
			'<!doctype html><title>Folio automatic extraction</title><script type="module" src="/extraction.js"></script>'
		]
	} satisfies Record<string, [string, string | Buffer]>;
}

if (import.meta.main) {
	const assets = Object.fromEntries(
		Object.entries(browserExtractionAssets()).map(([path, [type, body]]) => [
			path,
			{
				type,
				text: typeof body === 'string' ? body : undefined,
				bytes: typeof body === 'string' ? undefined : [...body]
			}
		])
	);
	mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
	writeFileSync(
		new URL('../build/extraction-assets.json', import.meta.url),
		JSON.stringify(assets)
	);
}
