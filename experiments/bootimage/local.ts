import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { bundle, bundleModules } from '../lib/bundle.ts';
import { driveMemory, moduleOf, sequence, variantOf, type Variant } from './plan.ts';

// run `node experiments/bootimage/prepare.ts` first; the bundle needs the staged modules
export async function runLocal(variant: Variant) {
	const root = bundle('bootimage', `experiments/bootimage/wrangler.${moduleOf[variant]}.jsonc`);
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

/** The memory-mode sequence in local workerd, with the ballast capped so the dry run stays small. */
export async function runLocalMemory(variant: Variant, maxSteps: number) {
	const root = bundle('bootimage', `experiments/bootimage/wrangler.${moduleOf[variant]}.jsonc`);
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			...bundleModules(root),
			compatibilityDate: '2026-10-20',
			bindings: { PROBE_TOKEN: 'local-only' },
			durableObjects: { IMAGE: { className: 'BootImage', useSQLite: true } }
		})
	);
	try {
		return await driveMemory(
			variant,
			async (path) => {
				const response = await mf.dispatchFetch(`https://bootimage.local${path}`, {
					headers: { authorization: 'Bearer local-only' }
				});
				return { status: response.status, body: await response.text() };
			},
			() => {},
			maxSteps
		);
	} finally {
		await mf.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}

if (import.meta.main && process.argv[3] === 'memory') {
	const variant = variantOf(process.argv[2]);
	assert.ok(variant === 'a' || variant === 'c', 'usage: local.ts original|render memory [steps]');
	const rows = await runLocalMemory(variant, Number(process.argv[4] ?? 3));
	const bodies = rows.map((row: any) => ({ ...row, body: JSON.parse(row.body) }));
	const last = (group: string) => bodies.filter((row: any) => row.group === group);
	console.log(
		JSON.stringify({
			variant,
			mode: 'memory',
			requests: rows.length,
			allOk: rows.every((row: any) => row.status === 200),
			keeps: bodies.filter((row: any) => row.group.endsWith('-keep')).length,
			ballast: bodies.filter((row: any) => row.group.endsWith('-ballast')).length,
			largestLiveBytes: Math.max(...bodies.map((row: any) => row.body.liveBytes ?? 0)),
			memoryBytes: [...new Set(bodies.map((row: any) => row.body.memoryBytes))],
			meterObjectsTags: new Set(
				last(`${variant === 'a' ? 'a64' : 'c86'}-meter`).map(
					(row: any) => row.body.moduleTag
				)
			).size,
			localOnly: true
		})
	);
} else if (import.meta.main) {
	const variant = variantOf(process.argv[2]);
	assert.ok(variant, 'usage: local.ts original|boot|render');
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
