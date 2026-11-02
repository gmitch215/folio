import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { rmSync } from 'node:fs';
import { bundle, bundleModules } from '../lib/bundle.ts';
import { ARENAS, FILLS } from './layout.ts';
import type { Lanes } from './plan.ts';

const token = 'local-only';

export interface Call {
	arm: 'snapshot' | 'ranges' | 'serial';
	arena: number;
	fill?: 'zero' | 'random';
	waves?: number;
	rounds?: number;
	cache?: 'cold' | 'warm';
}

// run `node experiments/ranges/prepare.ts` first; the bundles need the generated artifact
export async function startLocal(
	faults: Partial<Record<1 | 2 | 3 | 4, string>> = {},
	lanes: Lanes = 'worker',
	inline = false,
	runs = false
) {
	const objects = lanes === 'do';
	const lane = objects ? undefined : bundle('ranges-lane', 'experiments/ranges/wrangler.jsonc');
	const coordinator = bundle(
		'ranges-coordinator',
		objects
			? 'experiments/ranges/wrangler.coordinator.do.jsonc'
			: 'experiments/ranges/wrangler.coordinator.jsonc'
	);
	const common = { compatibilityDate: '2026-08-22', compatibilityFlags: ['nodejs_compat'] };
	const faulty = Object.entries(faults)[0];
	const owner = objects
		? {
				name: 'coordinator',
				...bundleModules(coordinator),
				...common,
				bindings: {
					PROBE_TOKEN: token,
					RUN_NAME: 'local',
					...(inline ? { INLINE: '1' } : {}),
					...(runs ? { RUNS: '1' } : {}),
					...(faulty ? { FAULT: faulty[1], FAULT_SUFFIX: `-lane-${faulty[0]}` } : {})
				},
				durableObjects: { LANEOBJ: { className: 'LaneObject', useSQLite: true } }
			}
		: {
				name: 'coordinator',
				...bundleModules(coordinator),
				...common,
				bindings: { PROBE_TOKEN: token, ...(runs ? { RUNS: '1' } : {}) },
				serviceBindings: Object.fromEntries(
					[1, 2, 3, 4].map((index) => [`LANE${index}`, `lane${index}`])
				)
			};
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				owner,
				...(lane
					? [1, 2, 3, 4].map((index) => ({
							name: `lane${index}`,
							...bundleModules(lane),
							...common,
							bindings: {
								...(faults[index as 1 | 2 | 3 | 4]
									? { FAULT: faults[index as 1 | 2 | 3 | 4]! }
									: {}),
								...(inline ? { INLINE: '1' } : {})
							}
						}))
					: [])
			]
		})
	);
	const fetchOptions = { headers: { authorization: `Bearer ${token}` } };
	const get = (path: string) => mf.dispatchFetch(`http://ranges.local${path}`, fetchOptions);
	return {
		async prepare(arena: number, fill: 'zero' | 'random' = 'zero') {
			const response = await get(`/prepare?arena=${arena}&fill=${fill}`);
			return (await response.json()) as any;
		},
		async call(call: Call) {
			const query = new URLSearchParams({
				arm: call.arm,
				arena: String(call.arena),
				fill: call.fill ?? 'zero',
				waves: String(call.waves ?? 4),
				rounds: String(call.rounds ?? 2),
				cache: call.cache ?? 'cold'
			});
			const began = performance.now();
			const response = await get(`/run?${query}`);
			const body: any = await response.json();
			return { status: response.status, wallMs: performance.now() - began, body };
		},
		async memory() {
			return new Uint8Array(await (await get('/memory')).arrayBuffer());
		},
		async dispose() {
			await mf.dispose();
			if (lane) rmSync(lane, { recursive: true, force: true });
			rmSync(coordinator, { recursive: true, force: true });
		}
	};
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

// node experiments/ranges/local.ts [repeats]: the matrix on local workerd, one JSON row per cell
if (import.meta.main) {
	const repeats = Number(process.argv[2] ?? 5);
	const local = await startLocal();
	try {
		for (const arena of ARENAS)
			for (const fill of FILLS) {
				await local.prepare(arena, fill);
				const cells = [
					{ arm: 'snapshot', cache: 'cold' },
					{ arm: 'ranges', cache: 'cold' },
					{ arm: 'ranges', cache: 'warm' },
					{ arm: 'serial', cache: 'cold' }
				] as const;
				const rows: Record<string, { walls: number[]; body: any }> = {};
				for (let i = 0; i < repeats; i++)
					for (const cell of cells) {
						const result = await local.call({ ...cell, arena, fill });
						const key = `${cell.arm}-${cell.cache}`;
						rows[key] ??= { walls: [], body: undefined };
						rows[key].walls.push(result.wallMs);
						rows[key].body = result.body;
					}
				const reference = rows['serial-cold']!.body;
				for (const [key, { walls, body }] of Object.entries(rows))
					console.log(
						JSON.stringify({
							arena,
							fill,
							cell: key,
							exact:
								body.digest === reference.digest && body.value === reference.value,
							sent: body.meter.bytesOut,
							received: body.meter.bytesIn,
							reportSent: body.report.transportBytes.sent,
							laneCalls: body.meter.calls,
							escapeRounds: body.report.escapeRounds ?? null,
							rangeBytes: body.report.rangeBytes ?? null,
							transportFallbacks: body.report.transportFallbacks,
							wallMs: Number(median(walls).toFixed(1)),
							minMs: Number(Math.min(...walls).toFixed(1)),
							maxMs: Number(Math.max(...walls).toFixed(1))
						})
					);
			}
	} finally {
		await local.dispose();
	}
}
