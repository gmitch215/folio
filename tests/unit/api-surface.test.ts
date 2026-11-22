import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, test } from 'vitest';
import {
	checkDist,
	closure,
	diffSurfaces,
	dynamicImportTargets,
	jsCandidate,
	migrationRows,
	migrationTable,
	recordSurface,
	specifier,
	unionReport,
	workerLiterals
} from '../../scripts/build/api-surface.ts';

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'api-surface-'));
	roots.push(root);
	for (const [path, source] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, source);
	}
	return root;
}

const exportsMap = {
	'.': { types: './dist/index.d.ts', import: './dist/index.js' },
	'./package.json': './package.json'
};

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('record lists runtime and declaration names with their source module', async () => {
	const root = fixture({
		'package.json': '{"type":"module"}',
		'dist/core.js': 'export const alpha = 1;\nexport function beta() { return 2; }\n',
		'dist/core.d.ts':
			'export declare const alpha: number;\nexport declare function beta(): number;\nexport type Gamma = number;\n',
		'dist/index.js': "export * from './core.js';\n",
		'dist/index.d.ts': "export * from './core.js';\n"
	});
	const surface = await recordSurface(root, exportsMap);
	assert.deepEqual(surface.keys['.'], {
		runtime: ['alpha', 'beta'],
		declarations: { alpha: 'src/core.ts', beta: 'src/core.ts', Gamma: 'src/core.ts' }
	});
});

test('diff is empty for an unchanged surface and names removed exports', async () => {
	const files = {
		'package.json': '{"type":"module"}',
		'dist/core.js': 'export const alpha = 1;\nexport function beta() { return 2; }\n',
		'dist/core.d.ts':
			'export declare const alpha: number;\nexport declare function beta(): number;\n',
		'dist/index.js': "export * from './core.js';\n",
		'dist/index.d.ts': "export * from './core.js';\n"
	};
	const base = await recordSurface(fixture(files), exportsMap);
	assert.deepEqual(diffSurfaces(base, await recordSurface(fixture(files), exportsMap)), []);

	const smaller = fixture({
		...files,
		'dist/core.js': 'export const alpha = 1;\n',
		'dist/core.d.ts': 'export declare const alpha: number;\n'
	});
	assert.deepEqual(diffSurfaces(base, await recordSurface(smaller, exportsMap)), [
		'. runtime removed: beta',
		'. declarations removed: beta'
	]);
});

test('worker and dynamic import scans keep only worker URLs and relative imports', () => {
	const source = [
		"const a = new URL('./browser-worker.js', import.meta.url);",
		"const b = new URL(`./router-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);",
		"const c = new URL('./data.json', import.meta.url);",
		"await import('./iteration.js');"
	].join('\n');
	assert.deepEqual(workerLiterals(source), [
		'./browser-worker.js',
		"./router-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}"
	]);
	assert.equal(jsCandidate('./worker.${extension}'), './worker.js');
	assert.deepEqual(dynamicImportTargets(source), ['./iteration.js']);
});

test('checkDist reports a missing worker target and a .ts dynamic import', () => {
	const root = fixture({
		'dist/core.js': 'export const alpha = 1;\n',
		'dist/w.js': [
			'new URL(`./gone-worker.${extension}`, import.meta.url);',
			"await import('./core.js');",
			"await import('./absent.ts');"
		].join('\n')
	});
	const checks = checkDist(join(root, 'dist'));
	assert.deepEqual(
		checks.map((check) => [check.kind, check.literal, check.target, check.ok]),
		[
			['url', './gone-worker.${extension}', './gone-worker.js', false],
			['import', './core.js', './core.js', true],
			['import', './absent.ts', './absent.js', false]
		]
	);
});

test('union lists lost and added names, and ignores a declaration whose source file moved', () => {
	const base = {
		keys: {
			'.': {
				runtime: ['alpha'],
				declarations: { alpha: 'src/core.ts', Gamma: 'src/core.ts' }
			},
			'./bake': { runtime: ['bake'], declarations: { bake: 'src/bake.ts' } }
		}
	};
	const current = {
		keys: {
			'.': {
				runtime: ['alpha', 'extra'],
				declarations: { alpha: 'src/execution/core.ts', extra: 'src/x.ts' }
			}
		}
	};
	assert.deepEqual(unionReport(base, current), {
		runtime: 2,
		declarations: 3,
		lost: ['runtime bake', 'declarations Gamma', 'declarations bake'],
		added: ['runtime extra', 'declarations extra']
	});
});

test('portable closures flag type edges into Node folders and runtime Node builtins', () => {
	const root = fixture({
		'dist/workers.d.ts': "export type { M } from './managed/index.ts';\n",
		'dist/managed/index.d.ts':
			"import type { R } from '../node/index.ts';\nexport interface M extends R {}\n",
		'dist/node/index.d.ts':
			"import type { I } from '../iteration/owner.ts';\nexport interface R { i: I }\n",
		'dist/iteration/owner.d.ts': 'export type I = number;\n',
		'dist/workers.js': "export { M } from './managed/index.js';\n",
		'dist/managed/index.js': 'export const M = 1;\n',
		'dist/memory.d.ts': '/// <reference types="node" />\nexport declare const a: number;\n',
		'dist/memory.js':
			"import { Worker } from 'node:worker_threads';\nexport const a = Worker;\n"
	});
	const dist = join(root, 'dist');
	assert.deepEqual(closure(dist, 'workers.d.ts', true), {
		files: 4,
		violations: [
			'reaches node/index.d.ts: workers.d.ts > managed/index.d.ts > node/index.d.ts',
			'reaches iteration/owner.d.ts: workers.d.ts > managed/index.d.ts > node/index.d.ts > iteration/owner.d.ts'
		]
	});
	assert.deepEqual(closure(dist, 'workers.js', false), { files: 2, violations: [] });
	assert.deepEqual(closure(dist, 'memory.d.ts', true), {
		files: 1,
		violations: ['memory.d.ts references types node: memory.d.ts']
	});
	assert.deepEqual(closure(dist, 'memory.js', false), {
		files: 1,
		violations: ['memory.js imports node:worker_threads: memory.js']
	});
	assert.throws(() => closure(dist, 'absent.d.ts', true), /is not built/);
});

test('migration rows name the first new key that exports every name, and skip unchanged keys', () => {
	const base = {
		keys: {
			'./bake': { runtime: ['bake'], declarations: { bake: 'src/bake.ts' } },
			'./browser': { runtime: ['Browser'], declarations: { Browser: 'src/browser.ts' } }
		}
	};
	const current = {
		keys: {
			'.': { runtime: [], declarations: {} },
			'./boot': { runtime: ['bake'], declarations: { bake: 'src/memory/bake.ts' } },
			'./browser': {
				runtime: ['Browser'],
				declarations: { Browser: 'src/browser/browser.ts' }
			}
		}
	};
	const rows = migrationRows(base, current, ['./bake', './browser']);
	assert.deepEqual(rows, [{ from: './bake', to: './boot', declarations: ['bake'] }]);
	assert.equal(
		migrationTable(rows, '@gmitch215/folio'),
		[
			'| Old subpath | New subpath | Names |',
			'| --- | --- | --- |',
			'| `@gmitch215/folio/bake` | `@gmitch215/folio/boot` | `bake` |'
		].join('\n')
	);
	assert.equal(specifier('@gmitch215/folio', '.'), '@gmitch215/folio');
	assert.equal(specifier('@gmitch215/folio', './workers'), '@gmitch215/folio/workers');
});
