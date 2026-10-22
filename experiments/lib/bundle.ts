import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kind } from './cloudflare.ts';
import { wranglerPath } from './cloudflare.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));

// wrangler's dry run bundles the worker exactly as a deploy would, with no account or network
export function bundle(kind: Kind, config = `experiments/${kind}/wrangler.jsonc`) {
	const outdir = mkdtempSync(join(tmpdir(), `folio-${kind}-bundle-`));
	execFileSync(
		process.execPath,
		[wranglerPath(), 'deploy', '--dry-run', '--outdir', outdir, '--config', config],
		{ cwd: repository, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' }
	);
	return outdir;
}

export function bundleModules(root: string) {
	const files = readdirSync(root);
	const main = files.find((file) => file.endsWith('.js') && !file.endsWith('.js.map'));
	assert.ok(main, 'bundle missing');
	return {
		modulesRoot: root,
		modules: [
			{ type: 'ESModule' as const, path: resolve(root, main) },
			...files
				.filter((file) => file.endsWith('.wasm'))
				.map((file) => ({ type: 'CompiledWasm' as const, path: resolve(root, file) }))
		]
	};
}
