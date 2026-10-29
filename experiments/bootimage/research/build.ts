import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveConsumer } from '../../../scripts/probe/consumer-root.ts';
import { digest } from '../../../scripts/research/environment.ts';

const consumer = process.env.FOLIO_CONSUMER;
assert.ok(consumer, 'set FOLIO_CONSUMER');
const output = resolve(process.argv[2] ?? 'build/research/boot-runtime');
const pin = join(output, 'build/bootimage/interp');
mkdirSync(pin, { recursive: true });
const inputs: Record<string, string> = {};
for (const name of ['php8.5.tuned.wasm', 'php8.5-worker.tuned.mjs']) {
	const path = join(consumer, '.interp', name),
		data = readFileSync(path);
	inputs[name] = digest(data);
	copyFileSync(path, join(pin, name));
}
const renewal = readFileSync(join(consumer, 'src/site/php/boot-image/rekey.php'));
inputs.renewal = digest(renewal);
writeFileSync(join(output, 'renewal.php'), renewal);
const source = resolve('scripts/probe/boot-image.ts');
await build({
	entryPoints: ['experiments/bootimage/research/run.ts'],
	outfile: join(output, 'run.mjs'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	external: ['node:*', 'binaryen', 'esbuild'],
	plugins: [
		{
			name: 'research-context',
			setup(builder) {
				builder.onResolve({ filter: /^folio:boot-context$/ }, () => ({ path: source }));
				builder.onResolve({ filter: /^consumer:/ }, (args) => ({
					path: resolveConsumer(consumer, args.path)
				}));
				builder.onResolve({ filter: /^fflate-real$/ }, () =>
					builder.resolve('fflate', { resolveDir: consumer, kind: 'import-statement' })
				);
				builder.onResolve({ filter: /^fflate$/ }, (args) =>
					args.importer.endsWith('lazy-fs.ts')
						? { path: resolve('scripts/probe/timed-fflate.ts') }
						: undefined
				);
				builder.onLoad({ filter: /\/scripts\/probe\/boot-image\.ts$/ }, (args) => {
					const text = readFileSync(args.path, 'utf8');
					inputs['boot-image.ts'] = digest(text);
					const dispatch = text.lastIndexOf("\nif (mode === 'phases')");
					assert.ok(dispatch > 0, 'boot probe dispatcher not found');
					for (const anchor of [
						'printErr: () => {},',
						'const exports: Record<string, any> = { ...instance.exports };',
						'{ jsOnly: options.jsOnly }'
					])
						assert.equal(
							text.slice(0, dispatch).split(anchor).length,
							2,
							`boot probe hook changed: ${anchor}`
						);
					const adapted = text
						.slice(0, dispatch)
						.replace(
							'printErr: () => {},',
							'printErr: (message: unknown) => console.error(message),'
						)
						.replace(
							'const exports: Record<string, any> = { ...instance.exports };',
							'if (options.researchAfterInstantiate) options.researchAfterInstantiate(instance, memory);\nconst exports: Record<string, any> = { ...instance.exports };'
						)
						.replace(
							'{ jsOnly: options.jsOnly }',
							'{ jsOnly: options.jsOnly, salt: options.researchSalt }'
						);
					return {
						contents: adapted + '\nexport { openContext, heapStore, stubImports };\n',
						loader: 'ts'
					};
				});
				builder.onLoad({ filter: /\/scripts\/probe\/php-context-drupal\.ts$/ }, (args) => {
					const text = readFileSync(args.path, 'utf8');
					inputs['php-context-drupal.ts'] = digest(text);
					assert.ok(
						text.includes("new DatabaseSync(':memory:')") &&
							text.includes('const manifest = JSON.parse(')
					);
					return {
						loader: 'ts',
						contents: text
							.replace(
								"new DatabaseSync(':memory:')",
								"new DatabaseSync(process.env.FOLIO_RESEARCH_DB ?? ':memory:')"
							)
							.replace(
								'const manifest = JSON.parse(',
								'if (process.env.FOLIO_RESEARCH_DB) return;\nconst manifest = JSON.parse('
							)
					};
				});
			}
		}
	]
});
inputs.bundle = digest(readFileSync(join(output, 'run.mjs')));
writeFileSync(join(output, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
console.log(JSON.stringify({ pinned: inputs, output: 'run.mjs' }));
