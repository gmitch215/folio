import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { events } from '../cloud/analyze-tail.ts';
import type { Child } from '../lib/cloudflare.ts';
import {
	createApi,
	credentials,
	inventory,
	inventoryDiff,
	retire,
	spawnWrangler,
	stopTail
} from '../lib/cloudflare.ts';
import type { Call, Cell, Level, Sample, TraceEvent } from './plan.ts';
import {
	attribute,
	CAL_EMPTY,
	CAL_PASSES,
	CAL_PROBE,
	CAL_VERIFY,
	decide,
	FAILURE_STREAK,
	INVOCATION_CAP,
	invocations,
	join,
	lcg,
	LOADED,
	median,
	MIN_NET_MS,
	plan,
	PREFIX,
	PRICES,
	PROBE_MIN_NET_MS,
	PROBE_ROUNDS,
	REPS,
	scaleRounds,
	schedule,
	SEED,
	summarize,
	TARGET_CPU_MS,
	WARMUPS,
	WIDTH,
	withinTolerance
} from './plan.ts';

const workersCompatibility = '2026-10-20';
const lanePath = 'experiments/concurrency/wrangler.lane.jsonc';

const usd = (value: number) => `$${value.toFixed(value < 0.01 ? 5 : 4)}`;

/** The plan as the text a dry run prints. */
export function describePlan(reps = REPS) {
	const p = plan(reps);
	const first = schedule(0).map((c) => `${c.arm} ${c.level} x${c.k}`);
	return [
		'dry run: nothing is deployed and no Cloudflare call is made',
		`deploys: ${p.scripts} Worker scripts (1 coordinator with ${p.objects} Durable Object names, 4 lanes), all deleted at the end`,
		`cells: ${p.cellsPerRep} a repetition, ${p.reps} repetitions after ${p.warmups} warmup, interleaved across arms`,
		`invocations a repetition: ${p.perRep} (${p.perRepTopLevel} top-level requests)`,
		`calibration: at most ${p.calibrationRequests} requests`,
		`planned total: ${p.expected} invocations against a stated cap of ${p.cap} (${p.withinCap ? 'within the cap' : 'OVER THE CAP, the run refuses to start'})`,
		`top-level requests: ${p.topLevelRequests}; Durable Object calls: ${p.counts.durableObjectRequests}; kernel cpu at most ${p.counts.cpuMs} ms`,
		`Durable Object duration, assumed active the whole run: ${p.counts.durableObjectGbSeconds.toFixed(1)} GB-s (assumption, not a measurement)`,
		`list-rate price, no monthly allowance applied (read ${PRICES.read}):`,
		`  worker requests ${usd(p.price.usd.workerRequests)}, cpu ${usd(p.price.usd.cpu)}, Durable Object requests ${usd(p.price.usd.durableObjectRequests)}, Durable Object duration ${usd(p.price.usd.durableObjectDuration)}`,
		`  total at most ${usd(p.price.total)}`,
		'repetition 0 order:',
		...first.map((line) => `  ${line}`)
	];
}

/** Parses a tail log, dropping a final event that the interrupt cut short. */
export function tailEvents(text: string) {
	let end = text.length;
	for (let tries = 0; tries < 4; tries++) {
		try {
			return events(text.slice(0, end)) as unknown as TraceEvent[];
		} catch {
			end = Math.max(
				text.lastIndexOf('}{', end - 1) + 1,
				text.lastIndexOf('\n{', end - 1) + 1
			);
		}
	}
	return [];
}

/** Joins the tail, summarizes and applies the decision rule; the live run and a re-analysis share it. */
export async function analyze(directory: URL, scripts: string[], samples: Sample[]) {
	const traces: TraceEvent[] = [];
	for (const script of scripts) {
		try {
			traces.push(
				...tailEvents(await readFile(new URL(`tail-${script}.jsonl`, directory), 'utf8'))
			);
		} catch {}
	}
	const joined = join(samples, attribute(traces));
	const rows = summarize(joined);
	const calls = joined.flatMap((s) => s.calls);
	return {
		tail: {
			events: traces.length,
			callsWithCpu: calls.filter((c) => c.cpuMs !== undefined).length,
			calls: calls.length,
			cpuMsInMeasuredCalls: calls.reduce((sum, c) => sum + (c.cpuMs ?? 0), 0)
		},
		rows,
		verdicts: decide(rows)
	};
}

class CapReached extends Error {}
class Wedged extends Error {}

async function live() {
	const reps = Number(process.env.FOLIO_CONCURRENCY_REPS ?? REPS);
	const p = plan(reps);
	assert.ok(p.withinCap, `planned ${p.expected} invocations exceed the cap of ${INVOCATION_CAP}`);
	const creds = credentials({
		FOLIO_CLOUDFLARE_ACCOUNT_ID: process.env.FOLIO_CLOUDFLARE_ACCOUNT_ID,
		FOLIO_CLOUDFLARE_API_TOKEN: process.env.FOLIO_CLOUDFLARE_API_TOKEN
	});
	const api = createApi(creds);
	execFileSync(process.execPath, ['experiments/concurrency/prepare.ts'], { stdio: 'pipe' });
	const root = new URL('../../', import.meta.url);
	const name = `${PREFIX}${crypto.randomUUID().slice(0, 8)}`;
	const lanes = [1, 2, 3, 4].map((index) => `${name}-l${index}`);
	const scripts = [name, ...lanes];
	const directory = new URL(`./runs/${name}/`, import.meta.url);
	await mkdir(directory, { recursive: true });
	const save = (file: string, value: unknown) =>
		writeFile(new URL(file, directory), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
	const log = (stage: string, extra: object = {}) =>
		console.log(JSON.stringify({ name, stage, ...extra }));
	const secret = crypto.randomUUID();
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
				await new Promise((resolve) => setTimeout(resolve, 4000));
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
		reps,
		warmups: WARMUPS,
		budget: { invocationCap: INVOCATION_CAP, plannedInvocations: p.expected },
		priced: { counts: p.counts, price: p.price }
	});
	log('baseline', { scripts: baseline.scripts?.length ?? null });

	const subdomain = (await api('/workers/subdomain')).subdomain;
	const base = `https://${name}.${subdomain}.workers.dev`;
	const laneBase = (slot: number) => `https://${lanes[slot]}.${subdomain}.workers.dev`;
	const headers = { authorization: `Bearer ${secret}` };
	let spent = 0;
	let rid = 0;
	let streak = 0;
	const tails: Child[] = [];
	const samples: Sample[] = [];
	const expected = new Map<number, number>();
	const checksum = (rounds: number) => {
		if (!expected.has(rounds)) expected.set(rounds, rounds === 0 ? SEED : lcg(rounds));
		return expected.get(rounds)!;
	};

	async function get(url: string, timeout = 60000) {
		let status: number | null = null;
		let body: any = null;
		let error: string | undefined;
		try {
			const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
			status = response.status;
			const text = await response.text();
			try {
				body = JSON.parse(text);
			} catch {
				error = text.slice(0, 500);
			}
			if (status !== 200) error ??= JSON.stringify(body)?.slice(0, 500);
		} catch (caught) {
			error = String((caught as Error)?.message ?? caught).slice(0, 500);
		}
		return { status, body, error };
	}

	// every cell is appended as it finishes, failures included
	async function measure(
		kind: string,
		rep: number,
		{ arm, level, k }: Cell,
		rounds: number
	): Promise<Sample> {
		const planned = invocations(arm, k);
		if (spent + planned > INVOCATION_CAP) throw new CapReached('invocation cap reached');
		spent += planned;
		const id = ++rid;
		const began = performance.now();
		let status: number | null = 200;
		let error: string | undefined;
		let coordinatorIsolate: string | undefined;
		let coordinatorColo: string | null | undefined;
		let calls: Call[] = [];
		if (arm === 'direct') {
			const results = await Promise.all(
				Array.from({ length: k }, async (_, slot) => {
					const result = await get(
						`${laneBase(slot)}/spin?rounds=${rounds}&rid=${id}&slot=${slot}`
					);
					if (result.status !== 200) {
						status = result.status;
						error ??= result.error;
					}
					return {
						slot,
						ok: result.status === 200 && !!result.body,
						...result.body
					} as Call;
				})
			);
			calls = results;
		} else {
			const query = new URLSearchParams({
				arm,
				k: String(k),
				rounds: String(rounds),
				rid: String(id),
				run: name
			});
			const result = await get(`${base}/run?${query}`);
			status = result.status;
			error = result.error;
			coordinatorIsolate = result.body?.coordinatorIsolate;
			coordinatorColo = result.body?.coordinatorColo;
			calls = result.body?.calls ?? [];
		}
		const clientWallMs = performance.now() - began;
		const sample: Sample = {
			rep,
			rid: id,
			arm,
			level,
			k,
			rounds,
			status,
			error,
			clientWallMs,
			coordinatorIsolate,
			coordinatorColo,
			calls,
			...(kind === 'cell' && calls.length === k
				? { exact: calls.every((c) => !c.ok || c.checksum === checksum(rounds)) }
				: {})
		};
		const good =
			status === 200 &&
			calls.length === k &&
			calls.every((c) => c.ok) &&
			sample.exact !== false;
		streak = good ? 0 : streak + 1;
		await appendFile(
			new URL('requests.jsonl', directory),
			`${JSON.stringify({ kind, ...sample })}\n`
		);
		if (streak >= FAILURE_STREAK) throw new Wedged(`${streak} failed cells in a row`);
		return sample;
	}

	let finished: string = 'complete';
	const rounds: Record<Level, number> = { empty: 0, low: 0, high: 0 };
	try {
		for (const script of lanes)
			await wrangler(
				['deploy', '--config', lanePath, '--name', script],
				`deploy-${script}.log`
			);
		const config = new URL(`wrangler.${name}.jsonc`, directory);
		await writeFile(
			config,
			JSON.stringify({
				name,
				main: '../../coordinator.ts',
				compatibility_date: workersCompatibility,
				workers_dev: true,
				services: lanes.map((service, index) => ({ binding: `LANE${index + 1}`, service })),
				durable_objects: { bindings: [{ name: 'LANES', class_name: 'LaneObject' }] },
				migrations: [{ tag: 'v1', new_sqlite_classes: ['LaneObject'] }]
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
		for (const script of lanes)
			await wrangler(
				['secret', 'put', 'PROBE_TOKEN', '--name', script, '--config', lanePath],
				`secret-${script}.log`,
				`${secret}\n`
			);

		// a fresh workers.dev route can answer 404 or 401 for a while; 200 means the route is live
		const wait = async (url: string, planned: number) => {
			let status: number | null = null;
			for (let attempt = 0; attempt < 30 && status !== 200; attempt++) {
				spent += planned;
				status = (await get(url, 30000)).status;
				if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 1500));
			}
			assert.equal(status, 200, 'routes not ready');
		};
		await wait(`${base}/ready?run=${name}`, 1 + 3 * WIDTH);
		for (let slot = 0; slot < WIDTH; slot++) await wait(`${laneBase(slot)}/ready`, 1);
		for (const script of scripts)
			tails.push(
				spawnWrangler(
					creds,
					['tail', script, '--format', 'json'],
					new URL(`tail-${script}.jsonl`, directory),
					{ cwd: root }
				)
			);
		for (const tail of tails) void tail.done.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 5000));
		log('ready', { tails: tails.length });

		// levels come from one call alone through worker-one, net of the empty loop; client wall is
		// the instrument because the clock inside a Worker does not move during a loop
		const alone = async (level: Level, count: number, value: number) => {
			const walls: number[] = [];
			for (let i = 0; i < count; i++)
				walls.push(
					(await measure('calibration', -1, { arm: 'worker-one', level, k: 1 }, value))
						.clientWallMs
				);
			return walls;
		};
		const fixed = [
			process.env.FOLIO_CONCURRENCY_ROUNDS_LOW,
			process.env.FOLIO_CONCURRENCY_ROUNDS_HIGH
		];
		const calibration: unknown[] = [];
		if (fixed[0] && fixed[1]) {
			rounds.low = Number(fixed[0]);
			rounds.high = Number(fixed[1]);
		} else {
			const empty = median(await alone('empty', CAL_EMPTY, 0));
			let probe = PROBE_ROUNDS[0]!;
			let net = 0;
			for (const attempt of PROBE_ROUNDS) {
				probe = attempt;
				net = median(await alone('low', CAL_PROBE, attempt)) - empty;
				calibration.push({ step: 'probe', rounds: attempt, netMs: net });
				if (net >= PROBE_MIN_NET_MS) break;
			}
			assert.ok(
				net >= MIN_NET_MS,
				`probe of ${probe} rounds netted ${net} ms; kernel too fast to calibrate`
			);
			for (const level of LOADED)
				rounds[level] = scaleRounds(probe, net, TARGET_CPU_MS[level]);
			for (let pass = 0; pass < CAL_PASSES; pass++) {
				let settled = true;
				for (const level of LOADED) {
					const netMs = median(await alone(level, CAL_VERIFY, rounds[level])) - empty;
					calibration.push({ step: 'verify', pass, level, rounds: rounds[level], netMs });
					if (!withinTolerance(netMs, TARGET_CPU_MS[level])) {
						settled = false;
						rounds[level] = scaleRounds(rounds[level], netMs, TARGET_CPU_MS[level]);
					}
				}
				if (settled) break;
			}
			calibration.push({ step: 'emptyWallMs', value: empty });
		}
		await save('calibration.json', { rounds, calibration });
		log('calibrated', { low: rounds.low, high: rounds.high });

		try {
			for (let rep = -WARMUPS; rep < reps; rep++)
				for (const cell of schedule(rep)) {
					const sample = await measure('cell', rep, cell, rounds[cell.level]);
					if (rep >= 0) samples.push(sample);
					log('cell', {
						rep,
						arm: cell.arm,
						level: cell.level,
						k: cell.k,
						status: sample.status,
						clientWallMs: Math.round(sample.clientWallMs)
					});
				}
			const placement = await get(`${base}/where?run=${name}`);
			spent += 1 + 3 * WIDTH;
			await save('placement.json', { hints: ['wnam', 'enam', 'weur', 'apac'], ...placement });
		} catch (error) {
			if (error instanceof Wedged) {
				finished = 'wedged';
				log('wedged', { message: error.message });
			} else if (error instanceof CapReached) {
				finished = 'cap';
				log('cap', { spent });
			} else throw error;
		}
	} finally {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		for (const tail of tails) await stopTail(tail);
		const present = async () =>
			(await api('/workers/scripts')).map((row: { id: string }) => row.id);
		if ((await present()).includes(name)) {
			try {
				await retire(api, name, ['LaneObject']);
			} catch {
				await api(`/workers/scripts/${name}`, { method: 'DELETE' }).catch(() => {});
			}
		}
		for (const script of lanes)
			if ((await present()).includes(script))
				await api(`/workers/scripts/${script}`, { method: 'DELETE' });
		const after = await inventory(api);
		await save('after.json', after);
		await save('samples.json', samples);
		// foreign changes belong to other users of the account; they are recorded and never touched
		const changes = inventoryDiff(baseline, after, mine);
		const leftovers = changes.filter((change) => change.mine);
		const foreignChanges = changes.filter((change) => !change.mine);
		log('cleanup', {
			leftovers: leftovers.length,
			foreignChanges: foreignChanges.length,
			spent,
			finished
		});
		await save('summary.json', {
			finished,
			invocations: spent,
			rounds,
			...(await analyze(directory, scripts, samples)),
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
	const analyseIndex = process.argv.indexOf('--analyze');
	if (process.argv.includes('--dry-run'))
		console.log(describePlan(Number(process.env.FOLIO_CONCURRENCY_REPS ?? REPS)).join('\n'));
	else if (analyseIndex > 0) {
		const name = process.argv[analyseIndex + 1] ?? '';
		assert.match(name, /^cfw-folio-concurrency-[a-z0-9]+$/);
		const directory = new URL(`./runs/${name}/`, import.meta.url);
		const samples: Sample[] = JSON.parse(
			await readFile(new URL('samples.json', directory), 'utf8')
		);
		const scripts = [name, ...[1, 2, 3, 4].map((index) => `${name}-l${index}`)];
		console.log(JSON.stringify(await analyze(directory, scripts, samples), null, 2));
	} else await live();
}
