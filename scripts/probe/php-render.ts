import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// usage: node scripts/probe/php-render.ts native|folio [OUTPUT.json] [PREPARED.bin]
// FOLIO_CONSUMER names a drupflare worker checkout with its dependencies and a restored .interp
const consumer = resolve(
	process.env.FOLIO_CONSUMER ?? new URL('../../../../drupflare/worker', import.meta.url).pathname
);
const bundle = new URL('../../build/php-render.mjs', import.meta.url).pathname;

// node refuses to strip types under node_modules, so the consumer's sources are bundled first
await build({
	entryPoints: [new URL('./php-render-entry.ts', import.meta.url).pathname],
	outfile: bundle,
	bundle: true,
	platform: 'node',
	format: 'esm',
	logLevel: 'error',
	plugins: [
		{
			name: 'consumer',
			setup(builder) {
				builder.onResolve({ filter: /^consumer:/ }, (args) => ({
					path: join(consumer, args.path.slice('consumer:'.length))
				}));
			}
		}
	]
});

const run = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {
	stdio: 'inherit',
	env: { ...process.env, FOLIO_CONSUMER: consumer }
});
process.exit(run.status ?? 1);
