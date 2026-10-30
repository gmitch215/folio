import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApi, credentials, snapshot, spawnWrangler } from '../lib/cloudflare.ts';

// deploys one coordinator and four lane scripts, measures whether service-bound and public-URL
// lanes overlap CPU work, then deletes all five scripts and compares the account to its baseline
const rounds = Number(process.env.FOLIO_RPC_ROUNDS ?? 14);
const warmups = 2;
const creds = credentials();
const api = createApi(creds);
const root = new URL('../../', import.meta.url);
const suffix = crypto.randomUUID().slice(0, 8);
const name = `cfw-folio-rpc-${suffix}`;
const lanes = [1, 2, 3, 4].map((index) => `${name}-l${index}`);
const directory = new URL(`./runs/${name}/`, import.meta.url);
await mkdir(directory, { recursive: true });
const save = (file: string, value: unknown) =>
	writeFile(new URL(file, directory), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const log = (stage: string, extra: object = {}) =>
	console.log(JSON.stringify({ name, stage, ...extra }));
const secret = crypto.randomUUID();
// a deploy can fail right after its upload while the new script propagates; each attempt keeps its log
const wrangler = (args: string[], file: string, input?: string) => ({
	done: (async () => {
		for (let attempt = 1; ; attempt++) {
			try {
				await spawnWrangler(creds, args, new URL(`${attempt}-${file}`, directory), {
					cwd: root,
					input
				}).done;
				return;
			} catch (error) {
				if (attempt === 3) throw error;
				await new Promise((resolve) => setTimeout(resolve, 4000));
			}
		}
	})()
});

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const baseline = await snapshot(api);
await save('baseline.json', baseline);
assert.equal(creds.label, 'FREE', 'run only on the Free account');
const subdomain = (await api('/workers/subdomain')).subdomain;
const publicUrl = (script: string) => `https://${script}.${subdomain}.workers.dev`;
const coordinatorUrl = publicUrl(name);
const waves = 6;
const invocationBound = 8000;
await save('run.json', {
	name,
	startedAt: new Date().toISOString(),
	account: creds.label,
	rounds,
	warmups,
	budget: { invocationBound, sqlCalls: 0, expectedCharges: 0 }
});
log('baseline', { workers: baseline.scripts.length });

let invocations = 0;
async function call(base: string, path: string) {
	invocations +=
		1 +
		Number(new URL(path, base).searchParams.get('k') ?? 0) *
			Number(new URL(path, base).searchParams.get('waves') ?? 1);
	assert.ok(invocations <= invocationBound, 'invocation bound reached');
	const response = await fetch(`${base}${path}`, {
		headers: { authorization: `Bearer ${secret}` },
		signal: AbortSignal.timeout(30000)
	});
	const text = await response.text();
	let body: any = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = { raw: text.slice(0, 200) };
	}
	return { status: response.status, body };
}
const fan = (arm: string, k: number, units: number, wave = waves) =>
	call(coordinatorUrl, `/fan?arm=${arm}&k=${k}&units=${units}&waves=${wave}`);

const phase = process.env.FOLIO_RPC_MODE ?? 'overlap';
const xferWaves = 4;
const xfer = (mode: string, arena: number, kernelRounds: number) =>
	call(
		coordinatorUrl,
		`/xfer?mode=${mode}&arena=${arena}&waves=${xferWaves}&rounds=${kernelRounds}&k=4`
	);

// four partitions of 16 KiB per cell; serial runs them on one lane, the other modes use four lanes
async function transfer() {
	const arenas = [131072, 1048576, 8388608];
	const modes = ['serial', 'full', 'range', 'retained'];
	// rounds per word: the smallest whose serial wall over all calls exceeds the empty kernel by 48 ms
	const calibration: { rounds: number; floorMs: number; wallMs: number; deltaMs: number }[] = [];
	let kernelRounds = 0;
	for (const candidate of [64, 128, 256, 512, 1024, 2048]) {
		const floor: number[] = [],
			wall: number[] = [];
		for (let i = 0; i < 8; i++) {
			floor.push((await xfer('serial', arenas[0]!, 0)).body.wallMs);
			const result = await xfer('serial', arenas[0]!, candidate);
			assert.deepEqual(result.body.statuses, [200], `calibration failed at ${candidate}`);
			wall.push(result.body.wallMs);
		}
		const deltaMs = median(wall) - median(floor);
		calibration.push({
			rounds: candidate,
			floorMs: median(floor),
			wallMs: median(wall),
			deltaMs
		});
		if (deltaMs >= 48) {
			kernelRounds = candidate;
			break;
		}
	}
	await save('calibration.json', calibration);
	assert.ok(kernelRounds > 0, 'no rounds reached 48 ms');
	// 16 serial calls per request; the free plan stops one call at 10 ms of CPU
	assert.ok(calibration.at(-1)!.deltaMs / (4 * xferWaves) < 7, 'rounds overshoot the CPU cap');
	log('calibrated', { kernelRounds, calibration });

	const cells = arenas.flatMap((arena) => modes.map((mode) => ({ mode, arena })));
	const samples: any[] = [];
	for (let round = -warmups; round < rounds; round++) {
		const order = cells.map((_, i) => cells[(i + Math.max(round, 0) * 5) % cells.length]!);
		for (const cell of round % 2 ? order.reverse() : order) {
			const result = await xfer(cell.mode, cell.arena, kernelRounds);
			if (round < 0) continue;
			samples.push({ round, ...cell, status: result.status, ...result.body });
		}
	}
	await save('samples.json', samples);
	const summary = arenas.flatMap((arena) =>
		modes.map((mode) => {
			const rows = samples.filter((s) => s.arena === arena && s.mode === mode);
			const ok = rows.filter(
				(s) => s.status === 200 && s.statuses?.length === 1 && s.statuses[0] === 200
			);
			// every round's digests must equal the serial run of the same round
			const equal = ok.filter((s) => {
				const control = samples.find(
					(c) => c.round === s.round && c.arena === arena && c.mode === 'serial'
				);
				return control && JSON.stringify(control.digests) === JSON.stringify(s.digests);
			});
			return {
				arena,
				mode,
				rows: rows.length,
				ok: ok.length,
				equalToSerial: equal.length,
				wallMs: ok.length ? median(ok.map((s) => s.wallMs)) : null,
				bytesOut: ok[0]?.bytesOut ?? null,
				bytesIn: ok[0]?.bytesIn ?? null,
				failures: [
					...new Set(
						rows
							.filter((r) => !ok.includes(r))
							.map((r) =>
								r.status === 200 ? JSON.stringify(r.statuses) : String(r.status)
							)
					)
				]
			};
		})
	);
	await save('summary.json', { kernelRounds, waves: xferWaves, summary });
	log('summary', { summary });
}

try {
	for (const script of lanes)
		await wrangler(
			['deploy', '--config', 'experiments/rpc/wrangler.jsonc', '--name', script],
			`deploy-${script}.log`
		).done;
	const coordinatorConfig = new URL('wrangler.coordinator.jsonc', directory);
	await writeFile(
		coordinatorConfig,
		JSON.stringify({
			name,
			main: '../../worker.ts',
			compatibility_date: '2026-10-19',
			workers_dev: true,
			services: lanes.map((service, index) => ({ binding: `LANE${index + 1}`, service })),
			vars: { LANE_URLS: JSON.stringify(lanes.map(publicUrl)) }
		})
	);
	await wrangler(
		['deploy', '--config', coordinatorConfig.pathname, '--name', name],
		'deploy-coordinator.log'
	).done;
	for (const script of [name, ...lanes])
		await wrangler(
			[
				'secret',
				'put',
				'PROBE_TOKEN',
				'--name',
				script,
				'--config',
				'experiments/rpc/wrangler.jsonc'
			],
			`secret-${script}.log`,
			`${secret}\n`
		).done;
	// a fresh workers.dev route can answer 404 for a while; 401 or 200 means the script replied
	const readiness: Record<string, number> = {};
	for (const script of [name, ...lanes]) {
		for (let attempt = 0; attempt < 30; attempt++) {
			const check = await fetch(`${publicUrl(script)}/spin`, {
				headers: { authorization: `Bearer ${secret}` },
				signal: AbortSignal.timeout(10000)
			});
			invocations++;
			readiness[script] = check.status;
			await check.body?.cancel();
			if (check.status === 200) break;
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
	}
	await save('readiness.json', readiness);
	assert.ok(
		Object.values(readiness).every((status) => status === 200),
		'routes not ready'
	);
	log('ready');
	if (phase === 'transfer') {
		await transfer();
	} else {
		// calibrate: the smallest units whose k=1 binding wall over all waves exceeds the empty call by 18 ms
		const calibration: { units: number; floorMs: number; wallMs: number; deltaMs: number }[] =
			[];
		let units = 0;
		for (const candidate of [8, 16, 32, 64, 128]) {
			const floor: number[] = [],
				wall: number[] = [];
			for (let i = 0; i < 8; i++) {
				floor.push((await fan('binding', 1, 0)).body.wallMs);
				const result = await fan('binding', 1, candidate);
				assert.equal(result.status, 200, `calibration failed at ${candidate}`);
				assert.equal(result.body.lanes[0].status, 200, `lane failed at ${candidate}`);
				wall.push(result.body.wallMs);
			}
			const deltaMs = median(wall) - median(floor);
			calibration.push({
				units: candidate,
				floorMs: median(floor),
				wallMs: median(wall),
				deltaMs
			});
			if (deltaMs >= 18) {
				units = candidate;
				break;
			}
		}
		await save('calibration.json', calibration);
		assert.ok(units > 0, 'no units reached 18 ms');
		// the free plan stops a request at 10 ms of CPU, so one lane call must stay well under it
		assert.ok(
			calibration.at(-1)!.deltaMs / waves < 7,
			'units overshoot the 10 ms free CPU cap'
		);
		log('calibrated', { units, calibration });

		// binding: heavy k=1,2,4 and empty k=1,4; public: one reachability cell
		const cells = [
			...[
				[1, units],
				[2, units],
				[4, units],
				[1, 0],
				[4, 0]
			].map(([k, u]) => ({ arm: 'binding', k: k!, units: u! })),
			{ arm: 'public', k: 1, units }
		];
		const samples: any[] = [];
		for (let round = -warmups; round < rounds; round++) {
			const order = cells.map((_, i) => cells[(i + Math.max(round, 0) * 3) % cells.length]!);
			for (const cell of round % 2 ? order.reverse() : order) {
				const result = await fan(cell.arm, cell.k, cell.units);
				if (round < 0) continue;
				samples.push({
					round,
					...cell,
					status: result.status,
					wallMs: result.body?.wallMs,
					lanes: result.body?.lanes
				});
			}
		}
		await save('samples.json', samples);

		const stat = (arm: string, k: number, u: number) => {
			const rows = samples.filter((s) => s.arm === arm && s.k === k && s.units === u);
			const ok = rows.filter(
				(s) => s.status === 200 && s.lanes.every((l: any) => l.status === 200)
			);
			return {
				rows: rows.length,
				ok: ok.length,
				wallMs: ok.length ? median(ok.map((s) => s.wallMs)) : NaN
			};
		};
		const publicStatuses = [
			...new Set(
				samples
					.filter((s) => s.arm === 'public')
					.flatMap((s) => (s.lanes ?? []).map((l: any) => l.status ?? l.error))
			)
		];
		const summary = ['binding'].map((arm) => {
			const heavy = [1, 2, 4].map((k) => ({ k, ...stat(arm, k, units) }));
			const empty = [1, 4].map((k) => ({ k, ...stat(arm, k, 0) }));
			const compute = (k: number) =>
				heavy.find((c) => c.k === k)!.wallMs - empty.find((c) => c.k === k)!.wallMs;
			const distinct = new Set(
				samples
					.filter((s) => s.arm === arm)
					.flatMap((s) => (s.lanes ?? []).map((l: any) => l.body?.instance))
			);
			return {
				arm,
				units,
				heavy,
				empty,
				computeMs: { k1: compute(1), k4: compute(4) },
				serializationIndexK4: compute(4) / compute(1),
				laneInstances: distinct.size
			};
		});
		await save('summary.json', { summary, publicStatuses, units, waves });
		log('summary', { summary, publicStatuses });
		log('usage', { invocations });
	}
} finally {
	for (const script of [name, ...lanes]) {
		const current = await snapshot(api);
		if (current.scripts.includes(script))
			await api(`/workers/scripts/${script}`, { method: 'DELETE' });
	}
	const after = await snapshot(api);
	await save('after.json', after);
	assert.deepEqual(after, baseline, 'account resource baseline differs');
	log('cleanup', { baselineRestored: true, invocations });
}
