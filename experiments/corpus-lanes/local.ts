import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { rmSync } from 'node:fs';
import { bundle, bundleModules } from '../lib/bundle.ts';

const token = 'local-only';

export interface Call {
	driver: string;
	arm: 'snapshot' | 'ranges' | 'serial';
	n: number;
	k?: number;
	width?: number;
	maxbytes?: number;
	fuel?: number;
	cache?: 'cold' | 'warm';
}

// run `node experiments/corpus-lanes/prepare.ts` first; the bundle needs the generated artifact
export async function startLocal(faults: Partial<Record<1 | 2 | 3 | 4, string>> = {}) {
	const coordinator = bundle(
		'corpus-lanes-coordinator',
		'experiments/corpus-lanes/wrangler.coordinator.jsonc'
	);
	const faulty = Object.entries(faults)[0];
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: 'coordinator',
					...bundleModules(coordinator),
					compatibilityDate: '2026-08-22',
					compatibilityFlags: ['nodejs_compat'],
					bindings: {
						PROBE_TOKEN: token,
						RUN_NAME: 'local',
						...(faulty ? { FAULT: faulty[1], FAULT_SUFFIX: `.lane${faulty[0]}` } : {})
					},
					durableObjects: { LANEOBJ: { className: 'LaneObject', useSQLite: true } }
				}
			]
		})
	);
	const get = (path: string) =>
		mf.dispatchFetch(`http://corpus.local${path}`, {
			headers: { authorization: `Bearer ${token}` }
		});
	return {
		async call(call: Call) {
			const query = new URLSearchParams({
				driver: call.driver,
				arm: call.arm,
				n: String(call.n),
				k: String(call.k ?? 0),
				width: String(call.width ?? 4),
				maxbytes: String(call.maxbytes ?? 0),
				fuel: String(call.fuel ?? 0),
				cache: call.cache ?? 'cold'
			});
			const began = performance.now();
			const response = await get(`/run?${query}`);
			const body: any = await response.json();
			return { status: response.status, wallMs: performance.now() - began, body };
		},
		async ready(driver: string) {
			return (await get(`/ready?driver=${driver}`)).status;
		},
		async dispose() {
			await mf.dispose();
			rmSync(coordinator, { recursive: true, force: true });
		}
	};
}
