import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import {
	createApi,
	credentials,
	inventory,
	inventoryDiff,
	retire,
	spawnWrangler
} from '../lib/cloudflare.ts';
import type { CalRow, CalStep, FaultRun, LaneError, Pair } from './plan.ts';
import {
	burnPasses,
	CAL_EMPTY,
	CAL_WARMUPS,
	calibrate,
	decide,
	DEPLOY_WAIT_MS,
	describePlan,
	fastestMsPerPass,
	FAULT_REPS,
	FAULTS,
	injected,
	LEASE_MS,
	median,
	pairOrder,
	PAIRS,
	plan,
	PREFIX,
	savedFailure,
	scrub,
	START_PASSES,
	taskId,
	unitMs,
	UNITS,
	WARMUP_PAIRS,
	WIDTH
} from './plan.ts';
import { chunk } from './task.ts';

const compatibility = '2026-10-20';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class CalibrationStop extends Error {}

/** Re-applies the decision rule to saved samples; the live run and a re-analysis share it. */
export async function analyze(directory: URL) {
	const read = async <T>(file: string) =>
		JSON.parse(await readFile(new URL(file, directory), 'utf8')) as T;
	return decide(await read<Pair[]>('pairs.json'), await read<FaultRun[]>('faults.json'));
}

async function live() {
	const p = plan();
	assert.ok(p.withinCap, 'the priced plan is over its cap');
	// the paid account only: no fallback to the Free plan pair
	const creds = credentials({
		FOLIO_CLOUDFLARE_ACCOUNT_ID: process.env.FOLIO_CLOUDFLARE_ACCOUNT_ID,
		FOLIO_CLOUDFLARE_API_TOKEN: process.env.FOLIO_CLOUDFLARE_API_TOKEN
	});
	const api = createApi(creds);
	const root = new URL('../../', import.meta.url);
	const name = `${PREFIX}${crypto.randomUUID().slice(0, 8)}`;
	const directory = new URL(`./runs/${name}/`, import.meta.url);
	await mkdir(directory, { recursive: true });
	const save = (file: string, value: unknown) =>
		writeFile(new URL(file, directory), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
	const log = (stage: string, extra: object = {}) =>
		console.log(JSON.stringify({ name, stage, ...extra }));
	const secret = crypto.randomUUID();
	const config = new URL(`wrangler.${name}.jsonc`, directory);
	const wrangler = async (args: string[], file: string, input?: string) => {
		for (let attempt = 1; ; attempt++) {
			try {
				await spawnWrangler(creds, args, new URL(`${attempt}-${file}`, directory), {
					cwd: root,
					input
				}).done;
				return;
			} catch (error) {
				if (attempt === 3) throw error;
				await sleep(4000);
			}
		}
	};
	const mine = (entry: Record<string, unknown>) =>
		String(entry.name ?? '').startsWith(PREFIX) ||
		String(entry.script ?? '').startsWith(PREFIX);

	const baseline = await inventory(api);
	await save('baseline.json', baseline);
	await save('run.json', {
		name,
		startedAt: new Date().toISOString(),
		account: creds.label,
		pairs: PAIRS,
		warmups: WARMUP_PAIRS,
		units: UNITS,
		width: WIDTH,
		priced: { counts: p.counts, price: p.price }
	});
	log('baseline', { scripts: baseline.scripts?.length ?? null });

	const subdomain: string = (await api('/workers/subdomain')).subdomain;
	const base = `https://${name}.${subdomain}.workers.dev`;
	const headers = { authorization: `Bearer ${secret}` };
	const secrets = [secret, creds.account, creds.token, subdomain, base];
	let requests = 0;
	const requestCap = 2 * p.counts.workerRequests;

	// a non-200 response keeps its whole body (capped) and its headers, scrubbed
	async function get(path: string, params: Record<string, string | number>, timeout = 180000) {
		assert.ok(++requests <= requestCap, 'request cap reached');
		const query = new URLSearchParams(
			Object.entries(params).map(([key, value]) => [key, String(value)])
		);
		const began = performance.now();
		let status: number | null = null;
		let body: any = null;
		let error: string | undefined;
		let failure: ReturnType<typeof savedFailure> | undefined;
		try {
			const response = await fetch(`${base}${path}?${query}`, {
				headers,
				signal: AbortSignal.timeout(timeout)
			});
			status = response.status;
			const text = await response.text();
			if (status !== 200) {
				const sent: [string, string][] = [];
				response.headers.forEach((value, key) => sent.push([key, value]));
				failure = savedFailure(text, sent, secrets);
			}
			try {
				body = JSON.parse(text);
			} catch {
				error = scrub(text.slice(0, 500), secrets);
			}
		} catch (caught) {
			error = scrub(String((caught as Error)?.message ?? caught).slice(0, 500), secrets);
		}
		const wallMs = performance.now() - began;
		await appendFile(
			new URL('requests.jsonl', directory),
			`${JSON.stringify({ path, params, status, wallMs, error, failure })}\n`
		);
		return { status, body, error, wallMs };
	}

	const pairs: Pair[] = [];
	const faults: FaultRun[] = [];
	let passes = START_PASSES;
	let finished = 'complete';
	let stopReason: string | undefined;
	try {
		await writeFile(
			config,
			JSON.stringify({
				name,
				main: '../../worker.ts',
				compatibility_date: compatibility,
				workers_dev: true,
				limits: { cpu_ms: 5000 },
				durable_objects: {
					bindings: [
						{ name: 'COORD', class_name: 'PoolCoordinator' },
						{ name: 'LANES', class_name: 'PoolLane' }
					]
				},
				migrations: [{ tag: 'v1', new_sqlite_classes: ['PoolCoordinator', 'PoolLane'] }]
			})
		);
		await wrangler(
			['deploy', '--config', config.pathname, '--name', name],
			`deploy-${name}.log`
		);
		await wrangler(
			['secret', 'put', 'PROBE_TOKEN', '--name', name, '--config', config.pathname],
			`secret-${name}.log`,
			`${secret}\n`
		);
		log('deployed', { waitMs: DEPLOY_WAIT_MS });
		await sleep(DEPLOY_WAIT_MS);
		let ready = await get('/ready', { run: name, k: WIDTH }, 30000);
		for (let attempt = 0; attempt < 30 && ready.status !== 200; attempt++) {
			await sleep(2000);
			ready = await get('/ready', { run: name, k: WIDTH }, 30000);
		}
		assert.equal(ready.status, 200, 'route not ready');
		const isolates = new Set((ready.body.lanes as { isolate: string }[]).map((l) => l.isolate));
		log('ready', { lanes: WIDTH, isolates: isolates.size });

		// the clock in a Worker does not move during a loop, so units are timed in client wall. A
		// calibration call has the shape of the timed serial arm: a fresh object, UNITS units
		const serialCall = (call: string, units: number, withPasses: number) =>
			get('/serial', {
				name: `${name}-${call}`,
				run: name,
				n: units,
				passes: withPasses,
				k: WIDTH
			});
		const emptyWalls: number[] = [];
		for (let i = 0; i < CAL_EMPTY; i++)
			emptyWalls.push((await serialCall(`cal-empty-${i}`, 0, passes)).wallMs);
		const empty = median(emptyWalls);
		// the timed arms run on a warm isolate, so calibration does too; a failed warmup is recorded
		for (let i = 0; i < CAL_WARMUPS; i++) await serialCall(`cal-warm-${i}`, UNITS, passes);
		const rows: CalRow[] = [];
		const observed: number[] = [];
		let step: CalStep = { action: 'measure', passes };
		while (step.action === 'measure') {
			passes = step.passes;
			const result = await serialCall(`cal-${passes}-${rows.length}`, UNITS, passes);
			const row = { passes, unitMs: unitMs(result.wallMs, empty), status: result.status };
			rows.push(row);
			if (row.status === 200) observed.push(row.unitMs / passes);
			step = calibrate(rows);
		}
		await save('calibration.json', { emptyMs: empty, rows, result: step });
		if (step.action === 'stop') throw new CalibrationStop(step.reason);
		log('calibrated', { passes, unitMs: Math.round(step.unitMs) });

		const expected = Array.from({ length: UNITS }, (_, i) => chunk(i, passes));
		const same = (outputs: unknown) => JSON.stringify(outputs) === JSON.stringify(expected);
		const arm = async (kind: 'serial' | 'pool', pair: number) => {
			const params = {
				name: `${name}-${kind}-${pair}`,
				run: name,
				n: UNITS,
				passes,
				k: WIDTH
			};
			const result = await get(kind === 'serial' ? '/serial' : '/pool', params);
			return {
				ms: result.wallMs,
				status: result.status,
				equal: result.status === 200 && same(result.body?.outputs)
			};
		};
		for (let pair = -WARMUP_PAIRS; pair < PAIRS; pair++) {
			const first = pairOrder(Math.max(pair, 0));
			const second = first === 'serial' ? 'pool' : 'serial';
			const a = await arm(first, pair);
			const b = await arm(second, pair);
			const byKind = { [first]: a, [second]: b };
			if (byKind.serial!.status === 200)
				observed.push(unitMs(byKind.serial!.ms, empty) / passes);
			if (pair >= 0)
				pairs.push({
					pair,
					first,
					serialMs: byKind.serial!.ms,
					poolMs: byKind.pool!.ms,
					serialStatus: byKind.serial!.status,
					poolStatus: byKind.pool!.status,
					equal: a.equal && b.equal
				});
			log('pair', {
				pair,
				serialMs: Math.round(byKind.serial!.ms),
				poolMs: Math.round(byKind.pool!.ms)
			});
		}

		// sized from the fastest pace seen, so the burn passes the cpu limit even at that pace
		const fastest = fastestMsPerPass(observed);
		assert.ok(fastest !== undefined, 'no cost per pass was observed');
		const burn = burnPasses(fastest);
		await save('burn.json', { fastestMsPerPass: fastest, burnPasses: burn });

		for (const fault of FAULTS)
			for (let rep = 1; rep <= FAULT_REPS; rep++) {
				const faulted = 2 + 3 * rep;
				const coordinator = `${name}-fault-${fault}-${rep}`;
				const result = await get('/pool', {
					name: coordinator,
					run: name,
					n: UNITS,
					passes,
					k: WIDTH,
					fault,
					index: faulted,
					burn
				});
				// a lane that slept past its lease reports after the run returns
				await sleep(fault === 'sleep' ? LEASE_MS * 2 : 3000);
				const state = (await get('/state', { name: coordinator }, 60000)).body;
				const id = taskId(faulted);
				const outcomes = (state?.outcomes ?? []) as {
					id: string;
					attempt: number;
					outcome: string;
				}[];
				const laneErrors: LaneError[] = result.body?.laneErrors ?? [];
				faults.push({
					fault,
					rep,
					status: result.status,
					injected: injected(fault, laneErrors, outcomes, id),
					laneErrors,
					attempts: state?.attempts ?? {},
					accepted: state?.accepted ?? {},
					faulted: id,
					done: result.body?.report?.done ?? 0,
					equal: result.status === 200 && same(result.body?.outputs)
				});
				log('fault', { fault, rep, status: result.status });
			}
	} catch (error) {
		if (error instanceof CalibrationStop) stopReason = error.message;
		finished = stopReason ? 'calibration stopped' : 'error';
		log('error', { message: String((error as Error)?.message ?? error).slice(0, 300) });
	} finally {
		const present = async () =>
			(await api('/workers/scripts')).map((row: { id: string }) => row.id);
		if ((await present()).includes(name)) {
			try {
				await retire(api, name, ['PoolCoordinator', 'PoolLane']);
			} catch {
				await api(`/workers/scripts/${name}`, { method: 'DELETE' }).catch(() => {});
			}
		}
		const after = await inventory(api);
		await save('after.json', after);
		await save('pairs.json', pairs);
		await save('faults.json', faults);
		const changes = inventoryDiff(baseline, after, mine);
		const leftovers = changes.filter((change) => change.mine);
		const foreignChanges = changes.filter((change) => !change.mine);
		const verdict = decide(pairs, faults);
		log('cleanup', {
			leftovers: leftovers.length,
			foreignChanges: foreignChanges.length,
			requests,
			finished,
			verdict: verdict.verdict
		});
		await save('summary.json', {
			finished,
			requests,
			passes,
			pairRatios: pairs.map((pair) => pair.serialMs / pair.poolMs),
			...(stopReason ? { verdict: 'stopped', reasons: [stopReason] } : verdict),
			leftovers,
			foreignChanges
		});
		assert.equal(
			leftovers.length,
			0,
			`own resources left behind: ${JSON.stringify(leftovers)}`
		);
	}
}

if (import.meta.main) {
	const at = process.argv.indexOf('--analyze');
	if (process.argv.includes('--dry-run')) console.log(describePlan().join('\n'));
	else if (at > 0) {
		const name = process.argv[at + 1] ?? '';
		assert.match(name, /^cfw-folio-lanepool-[a-z0-9]+$/);
		console.log(
			JSON.stringify(await analyze(new URL(`./runs/${name}/`, import.meta.url)), null, 2)
		);
	} else await live();
}
