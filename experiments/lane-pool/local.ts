import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { rmSync } from 'node:fs';
import { bundle, bundleModules } from '../lib/bundle.ts';
import { chunk } from './task.ts';

const token = 'local-only';

// the worker on local workerd; the lane pool's own units (claims, leases, replays) run for real
export async function startLocal() {
	const directory = bundle('lane-pool');
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: 'lane-pool',
					...bundleModules(directory),
					compatibilityDate: '2026-08-22',
					bindings: { PROBE_TOKEN: token },
					durableObjects: {
						COORD: { className: 'PoolCoordinator', useSQLite: true },
						LANES: { className: 'PoolLane', useSQLite: true }
					}
				}
			]
		})
	);
	return {
		async get(path: string, params: Record<string, string | number>) {
			const query = new URLSearchParams(
				Object.entries(params).map(([key, value]) => [key, String(value)])
			);
			const began = performance.now();
			const response = await mf.dispatchFetch(`http://lane-pool.local${path}?${query}`, {
				headers: { authorization: `Bearer ${token}` }
			});
			const text = await response.text();
			return {
				status: response.status,
				wallMs: performance.now() - began,
				body: response.status === 200 ? JSON.parse(text) : text
			};
		},
		async dispose() {
			await mf.dispose();
			rmSync(directory, { recursive: true, force: true });
		}
	};
}

// node experiments/lane-pool/local.ts [passes]: one serial and one pool run on local workerd. It
// checks the harness; local workerd says nothing about the platform
if (import.meta.main) {
	const passes = Number(process.argv[2] ?? 200);
	const units = 16;
	const run = `local-${Date.now().toString(36)}`;
	const local = await startLocal();
	try {
		await local.get('/ready', { run, k: 4 });
		const serial = await local.get('/serial', { name: `${run}-s`, n: units, passes });
		const pool = await local.get('/pool', { name: `${run}-p`, run, n: units, passes, k: 4 });
		const expected = Array.from({ length: units }, (_, i) => chunk(i, passes));
		console.log(
			JSON.stringify({
				passes,
				serialMs: Math.round(serial.wallMs),
				poolMs: Math.round(pool.wallMs),
				equal:
					JSON.stringify(serial.body.outputs) === JSON.stringify(expected) &&
					JSON.stringify(pool.body.outputs) === JSON.stringify(expected),
				report: pool.body.report,
				localOnly: true
			})
		);
	} finally {
		await local.dispose();
	}
}
