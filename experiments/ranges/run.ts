import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { events } from '../cloud/analyze-tail.ts';
import { PRICES } from '../concurrency/plan.ts';
import type { Api, Child } from '../lib/cloudflare.ts';
import {
	createApi,
	credentials,
	inventory,
	inventoryDiff,
	retire,
	spawnWrangler,
	stopTail
} from '../lib/cloudflare.ts';
import type { Arm, Lanes, Sample, TraceEvent } from './plan.ts';
import {
	attribute,
	chooseRounds,
	decide,
	DEFAULT_ROUNDS,
	expectedInvocations,
	FAILURE_STREAK,
	INVOCATION_CAP,
	LADDER,
	lanesFrom,
	PAID_LADDER,
	PAID_TARGET_MS,
	PER_REQUEST_LIMIT,
	PER_REQUEST_TARGET,
	plan,
	PREFIX,
	RANGE_TRIALS,
	schedule,
	summarize,
	TRIALS,
	WARMUPS
} from './plan.ts';

const arenaOfCalibration = 8388608;
const workersCompatibility = '2026-10-20';

const usd = (value: number) => `$${value.toFixed(value < 0.01 ? 5 : 4)}`;

/** The plan as the text a dry run prints. */
export function describePlan(
	rounds = DEFAULT_ROUNDS,
	options: { lanes?: Lanes; kernel?: number } = {}
) {
	const p = plan(rounds, options);
	const first = schedule(0).map((g) => `${g.arena / 1024} KiB ${g.fill}: ${g.arms.join(' > ')}`);
	const objects = p.lanes === 'do';
	return [
		'dry run: nothing is deployed and no Cloudflare call is made',
		objects
			? `lanes: Durable Object, ${p.deploys} Worker scripts (the owner and the snapshot owner, each with 4 SQLite-backed lane objects named from the run), all deleted at the end`
			: `lanes: service-bound Workers, ${p.deploys} Worker scripts (1 coordinator, 4 lanes), all deleted at the end`,
		`cells: ${p.groups} arena and fill groups, ${p.cellsPerRound} cells a round, ${p.rounds} rounds after ${p.warmups} warmup rounds`,
		`invocations: ${p.perRound} a round, ${p.calibration} for calibration, ${objects ? p.deploys * 5 : p.deploys} for readiness`,
		`planned total: ${p.expected} invocations against a stated cap of ${p.cap} (${p.withinCap ? 'within the cap' : 'OVER THE CAP, the run refuses to start'})`,
		`most invocations in one request: ${p.perRequestExpected} expected, ${p.perRequestUpper} at the bound of every dispatch using every frame (target ${PER_REQUEST_TARGET}, platform limit ${PER_REQUEST_LIMIT})`,
		...(objects
			? [
					`Durable Object stub calls count as invocations above; the docs name only service binding calls toward the limit of ${PER_REQUEST_LIMIT} and do not say whether a stub call counts (unverified), so ${p.perRequestWithoutObjectCalls} a request is the reading where they do not`,
					`Durable Object calls planned: ${p.durableObjectCallsPlanned}`
				]
			: []),
		`Durable Object rows: ${p.durableObjectRows}; storage calls: 0; ${objects ? 'Durable Object requests and duration are metered' : 'metered charges: none expected on the Free plan'}`,
		`share of the Free daily request allowance: ${(p.share * 100).toFixed(2)}% of 100,000, counting every invocation as a request`,
		...(p.priced
			? [
					`list-rate price at a fixed kernel of ${options.kernel} rounds, no monthly allowance applied (read ${PRICES.read}), every figure an upper bound from the constants in plan.ts:`,
					`  worker requests ${p.priced.counts.workerRequests} (${usd(p.priced.price.usd.workerRequests)}), cpu at most ${Math.round(p.priced.counts.cpuMs)} ms (${usd(p.priced.price.usd.cpu)}), Durable Object requests ${p.priced.counts.durableObjectRequests} (${usd(p.priced.price.usd.durableObjectRequests)})`,
					`  Durable Object duration ${p.priced.counts.durableObjectGbSeconds.toFixed(1)} GB-s at 128 MB over ${p.priced.objects} objects active ${Math.round(p.priced.activeSeconds)} s each, the whole run (${usd(p.priced.price.usd.durableObjectDuration)}); an assumption, not a measurement`,
					`  total at most ${usd(p.priced.price.total)}`
				]
			: []),
		'round 0 order:',
		...first.map((line) => `  ${line}`)
	];
}

const paid = /workers.*(paid|standard|bundled|unbound)/i;

/** Throws unless the account shows no paid Workers plan; an unreadable plan is accepted only for the Free pair. */
export async function verifyFree(api: Api, label: 'FREE' | 'SELECTED') {
	try {
		const subscriptions: any[] = await api('/subscriptions');
		assert.ok(
			!subscriptions.some(
				(row) => row.state === 'enabled' && paid.test(row.rate_plan?.id ?? '')
			),
			'paid Workers subscription detected'
		);
		return { checked: true, products: subscriptions.map((row) => row.rate_plan?.id) };
	} catch (error) {
		if (!String(error).includes('Authentication error')) throw error;
		assert.equal(label, 'FREE', 'cannot verify the Free plan for this account');
		return {
			checked: false,
			reason: 'token lacks billing scope; account came from the Free pair'
		};
	}
}

class CapReached extends Error {}
class Wedged extends Error {}

async function live() {
	const rounds = Number(process.env.FOLIO_RANGES_ROUNDS ?? DEFAULT_ROUNDS);
	const kind = lanesFrom(process.env.FOLIO_RANGES_LANES);
	const fixed = process.env.FOLIO_RANGES_KERNEL ? Number(process.env.FOLIO_RANGES_KERNEL) : 0;
	const p = plan(rounds, { lanes: kind, kernel: fixed });
	assert.ok(p.withinCap, `planned ${p.expected} invocations exceed the cap of ${INVOCATION_CAP}`);
	const creds = credentials();
	const api = createApi(creds);
	execFileSync(process.execPath, ['experiments/ranges/prepare.ts'], { stdio: 'pipe' });
	const metadata = JSON.parse(
		await readFile(new URL('./build/metadata.json', import.meta.url), 'utf8')
	);
	const root = new URL('../../', import.meta.url);
	const suffix = crypto.randomUUID().slice(0, 8);
	const name = `${PREFIX}${suffix}`;
	// Durable Object lanes live inside the two coordinators, so no lane scripts exist
	const lanes = kind === 'do' ? [] : [1, 2, 3, 4].map((index) => `${name}-l${index}`);
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

	// the author authorized the paid account on 2026-11-01 for the speedup gate the Free plan cannot reach
	const paid = process.env.FOLIO_RANGES_PLAN === 'paid';
	const plans = paid
		? { checked: false, reason: 'paid plan chosen by FOLIO_RANGES_PLAN' }
		: await verifyFree(api, creds.label);
	const mine = (entry: Record<string, unknown>) =>
		String(entry.name ?? '').startsWith(PREFIX) ||
		String(entry.script ?? '').startsWith(PREFIX);
	const baseline = await inventory(api);
	await save('baseline.json', baseline);
	await save('run.json', {
		name,
		record: process.env.FOLIO_RANGES_RECORD ?? 'first',
		startedAt: new Date().toISOString(),
		account: creds.label,
		plan: plans,
		lanes: kind,
		rounds,
		warmups: WARMUPS,
		sourceSha256: metadata.sourceSha256,
		budget: {
			invocationCap: INVOCATION_CAP,
			plannedInvocations: p.expected,
			durableObjectRows: 0,
			durableObjectCalls: p.durableObjectCallsPlanned,
			priced: p.priced
		}
	});
	log('baseline', { workers: baseline.scripts?.length ?? null, lanes: kind });

	const subdomain = (await api('/workers/subdomain')).subdomain;
	const base = `https://${name}.${subdomain}.workers.dev`;
	// the snapshot arm can overrun an isolate's memory, so it runs in a coordinator of its own
	const snapName = `${name}-snap`;
	const snapBase = `https://${snapName}.${subdomain}.workers.dev`;
	let invocations = 0;
	let rid = 0;
	let streak = 0;
	const tails: Child[] = [];
	const samples: Sample[] = [];

	// every request is appended as it finishes, failures included
	async function ask(kind: string, path: string, planned: number, arm?: Arm) {
		if (invocations + planned > INVOCATION_CAP) throw new CapReached('invocation cap reached');
		invocations += planned;
		const id = ++rid;
		const began = performance.now();
		let status: number | null = null;
		let body: any = null;
		let error: string | undefined;
		try {
			const response = await fetch(
				`${arm === 'snapshot' ? snapBase : base}${path}${path.includes('?') ? '&' : '?'}rid=${id}`,
				{
					headers: { authorization: `Bearer ${secret}` },
					signal: AbortSignal.timeout(30000)
				}
			);
			status = response.status;
			const text = await response.text();
			try {
				body = JSON.parse(text);
			} catch {
				error = text.slice(0, 2000);
			}
			if (status !== 200) error ??= JSON.stringify(body)?.slice(0, 2000);
		} catch (caught) {
			error = String((caught as Error)?.message ?? caught).slice(0, 2000);
		}
		if (kind === 'sample' || kind === 'calibration') streak = status === 200 ? 0 : streak + 1;
		const clientWallMs = performance.now() - began;
		// the coordinator counts its own lane calls; a response lost in transit keeps the planned figure
		const used = body?.meter ? 1 + body.meter.calls : planned;
		invocations += used - planned;
		await appendFile(
			new URL('requests.jsonl', directory),
			`${JSON.stringify({ kind, rid: id, arm, path, status, error, clientWallMs, invocations: used, body })}\n`
		);
		if (streak >= FAILURE_STREAK) throw new Wedged(`${streak} failed requests in a row`);
		return { id, status, body, error, clientWallMs, used };
	}

	const cell = async (
		round: number,
		arena: number,
		fill: Sample['fill'],
		arm: Arm,
		kernel: number
	) => {
		const query = new URLSearchParams({
			arm: arm.startsWith('ranges') ? 'ranges' : arm,
			arena: String(arena),
			fill,
			waves: '4',
			rounds: String(kernel),
			cache: arm === 'ranges-warm' ? 'warm' : 'cold',
			...(process.env.FOLIO_RANGES_FUEL ? { fuel: process.env.FOLIO_RANGES_FUEL } : {})
		});
		const result = await ask('sample', `/run?${query}`, expectedInvocations(arm, arena), arm);
		const body = result.body;
		if (body?.lanes !== undefined && body.lanes !== kind)
			throw new Error(`request ran on ${body.lanes} lanes, expected ${kind}`);
		const walls: number[] = (body?.meter?.laneWallMs ?? [])
			.slice()
			.sort((a: number, b: number) => a - b);
		const sample: Sample = {
			round,
			rid: result.id,
			arena,
			fill,
			arm,
			status: result.status,
			error: result.error,
			clientWallMs: result.clientWallMs,
			invocations: result.used,
			...(body?.report
				? {
						digest: body.digest,
						value: body.value,
						wallMs: body.wallMs,
						bytesOut: body.meter.bytesOut,
						bytesIn: body.meter.bytesIn,
						calls: body.meter.calls,
						laneFailures: body.meter.failures.length,
						transportFallbacks: body.report.transportFallbacks,
						escapeRounds: body.report.escapeRounds,
						footprintHits: body.report.footprintHits,
						rangeBytes: body.report.rangeBytes,
						laneWallMs: walls.length ? walls[walls.length >> 1] : undefined
					}
				: {})
		};
		log('cell', {
			round,
			arena,
			fill,
			arm,
			status: sample.status,
			clientWallMs: Math.round(sample.clientWallMs),
			invocations: sample.invocations
		});
		return sample;
	};

	let finished: string = 'complete';
	try {
		for (const script of lanes)
			await wrangler(
				['deploy', '--config', 'experiments/ranges/wrangler.jsonc', '--name', script],
				`deploy-${script}.log`
			);
		for (const coordinator of [name, snapName]) {
			const config = new URL(`wrangler.${coordinator}.jsonc`, directory);
			await writeFile(
				config,
				JSON.stringify({
					name: coordinator,
					main: '../../coordinator.ts',
					compatibility_date: workersCompatibility,
					compatibility_flags: ['nodejs_compat'],
					workers_dev: true,
					...(kind === 'do'
						? {
								vars: { RUN_NAME: coordinator },
								durable_objects: {
									bindings: [{ name: 'LANEOBJ', class_name: 'LaneObject' }]
								},
								migrations: [{ tag: 'v1', new_sqlite_classes: ['LaneObject'] }]
							}
						: {
								services: lanes.map((service, index) => ({
									binding: `LANE${index + 1}`,
									service
								}))
							})
				})
			);
			await wrangler(
				['deploy', '--config', config.pathname, '--name', coordinator],
				`deploy-${coordinator}.log`
			);
			await wrangler(
				[
					'secret',
					'put',
					'PROBE_TOKEN',
					'--name',
					coordinator,
					'--config',
					config.pathname
				],
				`secret-${coordinator}.log`,
				`${secret}\n`
			);
		}
		// a fresh workers.dev route can answer 404 or 401 for a while; 200 means every lane answered
		for (const arm of [undefined, 'snapshot' as Arm]) {
			let ready = 0;
			for (let attempt = 0; attempt < 30 && ready !== 200; attempt++) {
				ready = (await ask('ready', '/ready', 5, arm)).status ?? 0;
				if (ready !== 200) await new Promise((resolve) => setTimeout(resolve, 1500));
			}
			assert.equal(ready, 200, 'routes not ready');
		}
		for (const script of [name, snapName, ...lanes])
			tails.push(
				spawnWrangler(
					creds,
					['tail', script, '--format', 'json'],
					new URL(`tail-${script}.jsonl`, directory),
					{
						cwd: root
					}
				)
			);
		for (const tail of tails) void tail.done.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 5000));
		log('ready', { tails: tails.length });

		// the largest rounds the owner survives in serial, one ladder step below it for headroom
		await ask('prepare', `/prepare?arena=${arenaOfCalibration}&fill=zero`, 1);
		const survived: Record<number, boolean> = {};
		const calibration: { rounds: number; statuses: (number | null)[]; wallMs: number[] }[] = [];
		// a fixed kernel skips the ladder: a Free isolate that keeps running past its CPU budget is
		// terminated later, so surviving one request is not a safe size
		for (const candidate of fixed ? [] : paid ? PAID_LADDER : LADDER) {
			const row = {
				rounds: candidate,
				statuses: [] as (number | null)[],
				wallMs: [] as number[]
			};
			for (let i = 0; i < TRIALS; i++) {
				const result = await ask(
					'calibration',
					`/run?arm=serial&arena=${arenaOfCalibration}&fill=zero&waves=4&rounds=${candidate}`,
					1,
					'serial'
				);
				row.statuses.push(result.status);
				row.wallMs.push(result.clientWallMs);
			}
			// the owner also runs the ranges arm, whose coordination costs CPU of its own
			for (let i = 0; i < RANGE_TRIALS; i++) {
				const result = await ask(
					'calibration',
					`/run?arm=ranges&arena=${arenaOfCalibration}&fill=zero&waves=4&rounds=${candidate}&cache=cold`,
					expectedInvocations('ranges-cold', arenaOfCalibration),
					'ranges-cold'
				);
				row.statuses.push(result.status);
				row.wallMs.push(result.clientWallMs);
			}
			calibration.push(row);
			// on a paid plan the size is set by serial wall, the longest that stays under the target
			const serialWalls = row.wallMs.slice(0, TRIALS).sort((a, b) => a - b);
			survived[candidate] =
				row.statuses.every((status) => status === 200) &&
				(!paid || serialWalls[serialWalls.length >> 1]! <= PAID_TARGET_MS);
			if (!survived[candidate]) break;
		}
		const largest = PAID_LADDER.filter((candidate) => survived[candidate]).pop();
		const kernel = fixed || (paid ? (largest ?? PAID_LADDER[0]!) : chooseRounds(survived));
		await save('calibration.json', { survived, calibration, chosen: kernel });
		assert.ok(kernel !== null, 'the owner did not survive the smallest kernel');
		log('calibrated', { kernelRounds: kernel });

		try {
			for (let round = -WARMUPS; round < rounds; round++)
				for (const group of schedule(round)) {
					await ask('prepare', `/prepare?arena=${group.arena}&fill=${group.fill}`, 1);
					await ask(
						'prepare',
						`/prepare?arena=${group.arena}&fill=${group.fill}`,
						1,
						'snapshot'
					);
					for (const arm of group.arms) {
						const sample = await cell(round, group.arena, group.fill, arm, kernel);
						if (round >= 0) samples.push(sample);
					}
				}
		} catch (error) {
			if (error instanceof Wedged) {
				finished = 'wedged';
				log('wedged', { message: error.message });
			} else if (error instanceof CapReached) {
				finished = 'cap';
				log('cap', { invocations });
			} else throw error;
		}
	} finally {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		for (const tail of tails) await stopTail(tail);
		const present = async () =>
			(await api('/workers/scripts')).map((row: { id: string }) => row.id);
		for (const script of [name, snapName]) {
			if (!(await present()).includes(script)) continue;
			if (kind === 'do') {
				try {
					await retire(api, script, ['LaneObject']);
					continue;
				} catch {}
			}
			await api(`/workers/scripts/${script}`, { method: 'DELETE' });
		}
		for (const script of lanes)
			if ((await present()).includes(script))
				await api(`/workers/scripts/${script}`, { method: 'DELETE' });
		const after = await inventory(api);
		await save('after.json', after);
		// foreign changes belong to other users of the account; they are recorded and never touched
		const changes = inventoryDiff(baseline, after, mine);
		const leftovers = changes.filter((change) => change.mine);
		const foreignChanges = changes.filter((change) => !change.mine);
		log('cleanup', {
			leftovers: leftovers.length,
			foreignChanges: foreignChanges.length,
			invocations,
			finished
		});
		await save('samples.json', samples);

		// CPU comes from the tail events; with none, the lane wall seen by the coordinator stands in
		const traces: TraceEvent[] = [];
		for (const script of [name, snapName, ...lanes]) {
			try {
				traces.push(
					...(events(
						await readFile(new URL(`tail-${script}.jsonl`, directory), 'utf8')
					) as unknown as TraceEvent[])
				);
			} catch {}
		}
		const cpu = attribute(traces, name, lanes);
		const withCpu = samples.map((sample) => ({ ...sample, cpu: cpu.get(sample.rid) }));
		const rows = summarize(withCpu);
		const verdicts = decide(rows, withCpu);
		const covered = withCpu.filter((s) => s.cpu).length;
		await save('summary.json', {
			finished,
			lanes: kind,
			invocations,
			cpu: {
				source: covered ? 'wrangler tail cpuTime, integer milliseconds' : 'none',
				requestsWithCpu: covered,
				requests: samples.length,
				fallback: 'laneWallMs is the coordinator wall around each lane call, not CPU'
			},
			rows,
			verdicts,
			leftovers,
			foreignChanges
		});
		log('summary', { verdicts, requests: samples.length, requestsWithCpu: covered });
		assert.equal(
			leftovers.length,
			0,
			`own resources left behind: ${JSON.stringify(leftovers)}`
		);
	}
}

if (import.meta.main) {
	if (process.argv.includes('--dry-run'))
		console.log(
			describePlan(Number(process.env.FOLIO_RANGES_ROUNDS ?? DEFAULT_ROUNDS), {
				lanes: lanesFrom(process.env.FOLIO_RANGES_LANES),
				kernel: Number(process.env.FOLIO_RANGES_KERNEL ?? 0)
			}).join('\n')
		);
	else await live();
}
