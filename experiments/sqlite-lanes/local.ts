import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { rmSync } from 'node:fs';
import { bundle, bundleModules } from '../lib/bundle.ts';
import type { Arm } from './plan.ts';
import type { Shipment } from './ship.ts';

const token = 'local-only';

// run `node experiments/sqlite-lanes/prepare.ts` first; the bundle needs the module
export async function startLocal() {
	const coordinator = bundle(
		'sqlite-lanes',
		'experiments/sqlite-lanes/wrangler.coordinator.jsonc'
	);
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: 'coordinator',
					...bundleModules(coordinator),
					compatibilityDate: '2026-08-22',
					bindings: { PROBE_TOKEN: token },
					durableObjects: { SHARDS: { className: 'ShardObject' } }
				}
			]
		})
	);
	const headers = { authorization: `Bearer ${token}` };
	const base = 'http://sqlite-lanes.local';
	return {
		async load(run: string, part: Shipment) {
			const query = new URLSearchParams({
				run,
				set: part.set,
				slot: String(part.slot),
				sha: part.sha256,
				total: String(part.total),
				offset: String(part.offset),
				partSha: part.partSha256
			});
			const response = await mf.dispatchFetch(`${base}/load?${query}`, {
				method: 'POST',
				headers,
				body: part.bytes
			});
			return { status: response.status, body: (await response.json()) as any };
		},
		async run(
			run: string,
			arm: Arm | 'reference',
			query: string,
			rows: number,
			shas: string[]
		) {
			const params = new URLSearchParams({
				run,
				arm,
				query,
				rows: String(rows),
				shas: shas.join(',')
			});
			const response = await mf.dispatchFetch(`${base}/run?${params}`, { headers });
			return { status: response.status, body: (await response.json()) as any };
		},
		async ready() {
			return (await mf.dispatchFetch(`${base}/ready`, { headers })).status;
		},
		async dispose() {
			await mf.dispose();
			rmSync(coordinator, { recursive: true, force: true });
		}
	};
}
