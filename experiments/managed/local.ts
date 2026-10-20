import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { bundle, bundleModules } from '../lib/bundle.ts';

// run `node experiments/managed/prepare.ts` first; the bundle needs the generated artifact
export async function runLocal(output?: string) {
	const root = bundle('managed');
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			...bundleModules(root),
			compatibilityDate: '2026-08-22',
			compatibilityFlags: ['nodejs_compat'],
			bindings: { PROBE_TOKEN: 'local-only' },
			durableObjects: {
				LANES: { className: 'ManagedLane', useSQLite: true },
				OWNERS: { className: 'ManagedOwner', useSQLite: true }
			}
		})
	);
	try {
		const response = await mf.dispatchFetch('https://managed.local/run', {
			method: 'POST',
			headers: { authorization: 'Bearer local-only' }
		});
		const result: any = await response.json();
		if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
		assert.equal(response.status, 200, result.error);
		assert.equal(result.passed, true, result.error);
		return result;
	} finally {
		await mf.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const result = await runLocal(process.argv[2]);
	console.log(
		JSON.stringify({
			passed: true,
			rows: result.rows.length,
			jspi: result.jspi,
			wholeMemoryExact: result.rows.every((row: any) => row.exact),
			localOnly: true
		})
	);
}
