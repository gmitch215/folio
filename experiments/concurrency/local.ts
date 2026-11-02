import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { rmSync } from 'node:fs';
import { bundle, bundleModules } from '../lib/bundle.ts';
import type { Arm, Call } from './plan.ts';
import { ARMS, median, overlapIndex } from './plan.ts';

const token = 'local-only';

// run `node experiments/concurrency/prepare.ts` first; the bundles need the kernel
export async function startLocal() {
	const lane = bundle('concurrency-lane', 'experiments/concurrency/wrangler.lane.jsonc');
	const coordinator = bundle(
		'concurrency-coordinator',
		'experiments/concurrency/wrangler.coordinator.jsonc'
	);
	const common = { compatibilityDate: '2026-08-22' };
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: 'coordinator',
					...bundleModules(coordinator),
					...common,
					bindings: { PROBE_TOKEN: token },
					serviceBindings: Object.fromEntries(
						[1, 2, 3, 4].map((index) => [`LANE${index}`, `lane${index}`])
					),
					durableObjects: { LANES: { className: 'LaneObject', useSQLite: true } }
				},
				...[1, 2, 3, 4].map((index) => ({
					name: `lane${index}`,
					...bundleModules(lane),
					...common,
					bindings: { PROBE_TOKEN: token }
				}))
			]
		})
	);
	const options = { headers: { authorization: `Bearer ${token}` } };
	return {
		async run(arm: Exclude<Arm, 'direct'>, k: number, rounds: number, rid = 1) {
			const query = new URLSearchParams({
				arm,
				k: String(k),
				rounds: String(rounds),
				rid: String(rid),
				run: 'local'
			});
			const began = performance.now();
			const response = await mf.dispatchFetch(
				`http://concurrency.local/run?${query}`,
				options
			);
			const body: any = await response.json();
			return { status: response.status, wallMs: performance.now() - began, body };
		},
		// the direct arm: k separate requests, each to its own lane Worker
		async direct(k: number, rounds: number, rid = 1) {
			const began = performance.now();
			const results = await Promise.all(
				Array.from({ length: k }, async (_, slot) => {
					const worker = await mf.getWorker(`lane${slot + 1}`);
					const response = await worker.fetch(
						`http://lane.local/spin?rounds=${rounds}&rid=${rid}&slot=${slot}`,
						options
					);
					return { status: response.status, body: (await response.json()) as Call };
				})
			);
			return { wallMs: performance.now() - began, results };
		},
		async ready() {
			return mf.dispatchFetch('http://concurrency.local/ready?run=local', options);
		},
		async dispose() {
			await mf.dispose();
			rmSync(lane, { recursive: true, force: true });
			rmSync(coordinator, { recursive: true, force: true });
		}
	};
}

// node experiments/concurrency/local.ts [rounds] [repeats]: the arms on local workerd, as a sanity
// readout of the harness; local workerd is not the deployed platform
if (import.meta.main) {
	const rounds = Number(process.argv[2] ?? 20_000_000);
	const repeats = Number(process.argv[3] ?? 5);
	const local = await startLocal();
	try {
		await local.ready();
		for (const arm of ARMS) {
			const walls: Record<string, number[]> = { e1: [], e4: [], l1: [], l4: [] };
			for (let i = 0; i < repeats; i++)
				for (const [key, k, spin] of [
					['e1', 1, 0],
					['e4', 4, 0],
					['l1', 1, rounds],
					['l4', 4, rounds]
				] as const)
					walls[key]!.push(
						arm === 'direct'
							? (await local.direct(k, spin)).wallMs
							: (await local.run(arm, k, spin)).wallMs
					);
			const [e1, e4, l1, l4] = ['e1', 'e4', 'l1', 'l4'].map((key) => median(walls[key]!));
			console.log(
				JSON.stringify({
					arm,
					rounds,
					oneMs: Number(l1!.toFixed(1)),
					fourMs: Number(l4!.toFixed(1)),
					index: overlapIndex(l4!, e4!, l1!, e1!)?.toFixed(2) ?? null,
					localOnly: true
				})
			);
		}
	} finally {
		await local.dispose();
	}
}
