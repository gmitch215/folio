import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { bundle, bundleModules } from '../lib/bundle.ts';
import { isVariant, sequence, type Variant } from './plan.ts';

// run `node experiments/bootimage/prepare.ts` first; the bundle needs the staged modules
export async function runLocal(variant: Variant) {
	const root = bundle('bootimage', `experiments/bootimage/wrangler.${variant}.jsonc`);
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			...bundleModules(root),
			compatibilityDate: '2026-10-20',
			bindings: { PROBE_TOKEN: 'local-only' },
			durableObjects: { IMAGE: { className: 'BootImage', useSQLite: true } }
		})
	);
	try {
		const rows: Record<string, any>[] = [];
		for (const step of sequence(variant)) {
			const response = await mf.dispatchFetch(`https://bootimage.local${step.path}`, {
				headers: { authorization: 'Bearer local-only' }
			});
			rows.push({ ...step, status: response.status, body: await response.text() });
		}
		return rows;
	} finally {
		await mf.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const variant = process.argv[2];
	assert.ok(isVariant(variant), 'usage: local.ts a|b|c');
	const expected = JSON.parse(
		readFileSync(new URL('build/expected.json', import.meta.url), 'utf8')
	);
	const rows = await runLocal(variant);
	const { moduleOf } = await import('./plan.ts');
	const want = expected[moduleOf[variant]];
	const bodies = rows.map((row) => ({ ...row, body: JSON.parse(row.body) }));
	const checked = bodies.filter((row) => row.body.checksum !== undefined);
	console.log(
		JSON.stringify({
			variant,
			requests: rows.length,
			allOk: rows.every((row) => row.status === 200),
			checked: checked.length,
			checksumsMatch: checked.every((row) => row.body.checksum === want.checksum),
			memoryBytes: [...new Set(bodies.map((row) => row.body.memoryBytes))],
			localOnly: true
		})
	);
}
