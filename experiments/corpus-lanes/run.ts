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
import type { TraceEvent } from '../ranges/plan.ts';
import { attribute } from '../ranges/plan.ts';
import { verifyFree } from '../ranges/run.ts';
import type { Sample, Step } from './plan.ts';
import {
	decide,
	DEFAULT_ROUNDS,
	FAILURE_STREAK,
	FREE_CPU_LIMIT_MS,
	INVOCATION_CAP,
	laneCalls,
	only,
	ownerCpuMs,
	PER_REQUEST_LIMIT,
	plan,
	PREFIX,
	schedule,
	summarize,
	WARMUPS
} from './plan.ts';

const workersCompatibility = '2026-10-20';
const usd = (value: number) => `$${value.toFixed(value < 0.01 ? 5 : 4)}`;

/** The plan as the text a dry run prints. */
export function describePlan(rounds = DEFAULT_ROUNDS, list = only(undefined)): string[] {
	const p = plan(rounds, list);
	const first = schedule(0, list).map(
		(s) =>
			`${s.driver} ${s.kind} n=${s.n} k=${s.k} ${s.arm}: ${1 + laneCalls(s)} invocations, owner CPU about ${ownerCpuMs(s).toFixed(1)} ms`
	);
	const over = schedule(0, list).filter((s) => ownerCpuMs(s) > FREE_CPU_LIMIT_MS);
	return [
		'dry run: nothing is deployed and no Cloudflare call is made',
		'lanes: Durable Object, 1 Worker script (owner plus lane objects named from the run), deleted at the end',
		`drivers: ${p.drivers.join(', ')}`,
		`requests: ${p.requests} over ${p.rounds} rounds after ${p.warmups} warmup round`,
		`planned total: ${p.invocations} invocations against a stated cap of ${p.cap} (${p.withinCap ? 'within the cap' : 'OVER THE CAP, the run refuses to start'})`,
		`most invocations in one request: ${p.perRequestWorst} counting every lane stub call (platform limit ${PER_REQUEST_LIMIT} for service bindings; whether a stub call counts is unverified)`,
		`Durable Object rows: ${p.durableObjectRows}; storage calls: 0; Durable Object requests and duration are metered`,
		`owner CPU above the ${FREE_CPU_LIMIT_MS} ms Free Worker limit in ${over.length} of ${first.length} steps of round 0 (local per-address cost, an estimate): ${over.length ? 'run on the paid plan with FOLIO_CORPUS_PLAN=paid' : 'none'}`,
		`list-rate price, no monthly allowance applied, every figure an upper bound from the constants in plan.ts:`,
		`  worker requests ${p.priced.counts.workerRequests} (${usd(p.priced.price.usd.workerRequests)}), cpu at most ${Math.round(p.priced.counts.cpuMs)} ms (${usd(p.priced.price.usd.cpu)}), Durable Object requests ${p.priced.counts.durableObjectRequests} (${usd(p.priced.price.usd.durableObjectRequests)})`,
		`  Durable Object duration ${p.priced.counts.durableObjectGbSeconds.toFixed(1)} GB-s over ${p.priced.objects} objects active ${p.priced.activeSeconds} s each (${usd(p.priced.price.usd.durableObjectDuration)}); an assumption, not a measurement`,
		`  total at most ${usd(p.priced.price.total)}`,
		'round 0 order:',
		...first.map((line) => `  ${line}`)
	];
}

class CapReached extends Error {}
class Wedged extends Error {}

async function live() {
	const rounds = Number(process.env.FOLIO_CORPUS_ROUNDS ?? DEFAULT_ROUNDS);
	const list = only(process.env.FOLIO_CORPUS_ONLY);
	const p = plan(rounds, list);
	assert.ok(
		p.withinCap,
		`planned ${p.invocations} invocations exceed the cap of ${INVOCATION_CAP}`
	);
	const creds = credentials();
	const api = createApi(creds);
	execFileSync(process.execPath, ['experiments/corpus-lanes/prepare.ts'], { stdio: 'pipe' });
	const metadata = JSON.parse(
		await readFile(new URL('./build/metadata.json', import.meta.url), 'utf8')
	);
	for (const cell of list) assert.ok(metadata[cell.driver], `${cell.driver} was not built`);
	const root = new URL('../../', import.meta.url);
	const name = `${PREFIX}${crypto.randomUUID().slice(0, 8)}`;
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
	const paid = process.env.FOLIO_CORPUS_PLAN === 'paid';
	const plans = paid
		? { checked: false, reason: 'paid plan chosen by FOLIO_CORPUS_PLAN' }
		: await verifyFree(api, creds.label);
	const mine = (entry: Record<string, unknown>) =>
		String(entry.name ?? '').startsWith(PREFIX) ||
		String(entry.script ?? '').startsWith(PREFIX);
	const baseline = await inventory(api);
	await save('baseline.json', baseline);
	await save('run.json', {
		name,
		record: process.env.FOLIO_CORPUS_RECORD ?? 'first',
		startedAt: new Date().toISOString(),
		account: creds.label,
		plan: plans,
		rounds,
		warmups: WARMUPS,
		drivers: list.map((cell) => cell.driver),
		sources: Object.fromEntries(
			list.map((cell) => [cell.driver, metadata[cell.driver].sourceSha256])
		),
		budget: {
			invocationCap: INVOCATION_CAP,
			plannedInvocations: p.invocations,
			priced: p.priced
		}
	});
	log('baseline', { workers: baseline.scripts?.length ?? null });

	const subdomain = (await api('/workers/subdomain')).subdomain;
	const base = `https://${name}.${subdomain}.workers.dev`;
	let invocations = 0;
	let rid = 0;
	let streak = 0;
	const tails: Child[] = [];
	const samples: Sample[] = [];

	async function ask(kind: string, path: string, planned: number) {
		if (invocations + planned > INVOCATION_CAP) throw new CapReached('invocation cap reached');
		invocations += planned;
		const id = ++rid;
		const began = performance.now();
		let status: number | null = null;
		let body: any = null;
		let error: string | undefined;
		try {
			const response = await fetch(
				`${base}${path}${path.includes('?') ? '&' : '?'}rid=${id}`,
				{
					headers: { authorization: `Bearer ${secret}` },
					signal: AbortSignal.timeout(60000)
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
		if (kind === 'sample') streak = status === 200 ? 0 : streak + 1;
		const clientWallMs = performance.now() - began;
		const used = body?.meter ? 1 + body.meter.calls : planned;
		invocations += used - planned;
		await appendFile(
			new URL('requests.jsonl', directory),
			`${JSON.stringify({ kind, rid: id, path, status, error, clientWallMs, invocations: used, body })}\n`
		);
		if (streak >= FAILURE_STREAK) throw new Wedged(`${streak} failed requests in a row`);
		return { id, status, body, error, clientWallMs, used };
	}

	const cell = async (round: number, step: Step) => {
		const query = new URLSearchParams({
			driver: step.driver,
			arm: step.arm.startsWith('ranges') ? 'ranges' : 'serial',
			n: String(step.n),
			k: String(step.k),
			width: '4',
			cache: step.arm === 'ranges-warm' ? 'warm' : 'cold'
		});
		const result = await ask('sample', `/run?${query}`, 1 + laneCalls(step));
		const body = result.body;
		const sample: Sample = {
			round,
			rid: result.id,
			...step,
			status: result.status,
			error: result.error,
			clientWallMs: result.clientWallMs,
			...(body?.report
				? {
						digest: body.digest,
						wallMs: body.wallMs,
						exhaustedCalls: body.tracked.exhaustedCalls,
						fallbacks: body.report.fallbacks,
						transportFallbacks: body.report.transportFallbacks,
						laneFailures: body.meter.failures.length,
						escapeRounds: body.report.escapeRounds,
						footprintHits: body.report.footprintHits,
						rangeBytes: body.report.rangeBytes,
						bytesOut: body.meter.bytesOut,
						bytesIn: body.meter.bytesIn,
						tracked: body.tracked.reads + body.tracked.writes
					}
				: {})
		};
		log('cell', {
			round,
			driver: step.driver,
			kind: step.kind,
			arm: step.arm,
			status: sample.status,
			clientWallMs: Math.round(sample.clientWallMs)
		});
		return sample;
	};

	let finished: string = 'complete';
	try {
		const config = new URL(`wrangler.${name}.jsonc`, directory);
		await writeFile(
			config,
			JSON.stringify({
				name,
				main: '../../coordinator.ts',
				compatibility_date: workersCompatibility,
				compatibility_flags: ['nodejs_compat'],
				workers_dev: true,
				vars: { RUN_NAME: name },
				durable_objects: { bindings: [{ name: 'LANEOBJ', class_name: 'LaneObject' }] },
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
		// a fresh workers.dev route can answer 404 or 401 for a while; 200 means every lane answered
		for (const { driver } of list) {
			let ready = 0;
			for (let attempt = 0; attempt < 30 && ready !== 200; attempt++) {
				ready = (await ask('ready', `/ready?driver=${driver}`, 5)).status ?? 0;
				if (ready !== 200) await new Promise((resolve) => setTimeout(resolve, 1500));
			}
			assert.equal(ready, 200, 'routes not ready');
		}
		tails.push(
			spawnWrangler(
				creds,
				['tail', name, '--format', 'json'],
				new URL(`tail-${name}.jsonl`, directory),
				{
					cwd: root
				}
			)
		);
		for (const tail of tails) void tail.done.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 5000));
		log('ready', { tails: tails.length });
		try {
			for (let round = -WARMUPS; round < rounds; round++)
				for (const step of schedule(round, list)) {
					const sample = await cell(round, step);
					if (round >= 0) samples.push(sample);
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
		if ((await present()).includes(name)) {
			try {
				await retire(api, name, ['LaneObject']);
			} catch {
				await api(`/workers/scripts/${name}`, { method: 'DELETE' });
			}
		}
		const after = await inventory(api);
		await save('after.json', after);
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
		const traces: TraceEvent[] = [];
		try {
			traces.push(
				...(events(
					await readFile(new URL(`tail-${name}.jsonl`, directory), 'utf8')
				) as unknown as TraceEvent[])
			);
		} catch {}
		const cpu = attribute(traces, name, []);
		const withCpu = samples.map((sample) => ({ ...sample, cpu: cpu.get(sample.rid) }));
		const rows = summarize(withCpu);
		const verdicts = decide(rows, withCpu);
		const covered = withCpu.filter((s) => s.cpu).length;
		await save('summary.json', {
			finished,
			invocations,
			cpu: {
				source: covered ? 'wrangler tail cpuTime, integer milliseconds' : 'none',
				requestsWithCpu: covered,
				requests: samples.length
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
			describePlan(
				Number(process.env.FOLIO_CORPUS_ROUNDS ?? DEFAULT_ROUNDS),
				only(process.env.FOLIO_CORPUS_ONLY)
			).join('\n')
		);
	else await live();
}
