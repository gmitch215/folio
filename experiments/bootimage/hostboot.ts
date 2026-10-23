import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readMeter, type Meter } from '../consumer/drive.ts';
import {
	createApi,
	credentials,
	inventory,
	inventoryDiff,
	retire,
	snapshot,
	spawnWrangler,
	stopTail,
	type Child
} from '../lib/cloudflare.ts';
import { parseDeployLog } from './analyze.ts';
import {
	bodyHash,
	budgetFromEnv,
	summarizeRun,
	withinBudget,
	type Budget,
	type StepRow
} from './hostboot-analyze.ts';

// HOSTBOOT_ARMS=control=<dir>,par=<dir> names any number of arms (the older variables still work)
const arms: { arm: string; dir: string; fallback?: string }[] = process.env.HOSTBOOT_ARMS
	? process.env.HOSTBOOT_ARMS.split(',').map((item) => {
			const [arm, dir] = item.split('=');
			return { arm: arm!, dir: dir! };
		})
	: [
			{ arm: 'control', dir: process.env.HOSTBOOT_CONTROL_DIR! },
			{
				arm: 'baked',
				dir: process.env.HOSTBOOT_BAKED_DIR!,
				fallback: process.env.HOSTBOOT_FALLBACK_DIR
			}
		];
assert.ok(
	arms.every((a) => a.dir),
	'set HOSTBOOT_ARMS, or HOSTBOOT_CONTROL_DIR and HOSTBOOT_BAKED_DIR'
);
const rounds = Number(process.env.HOSTBOOT_ROUNDS ?? 5);
const budget: Budget = budgetFromEnv(process.env);
const classes = ['SitePhpDurableObject', 'RenderLane'];

const creds = credentials();
const api = createApi(creds);
const suffix = crypto.randomUUID().slice(0, 8);
const run = `cfw-folio-hostboot-${suffix}`;
const directory = new URL(`./runs/${run}/`, import.meta.url);
mkdirSync(directory, { recursive: true });
const save = (file: string, value: unknown) =>
	writeFileSync(new URL(file, directory), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const log = (stage: string, extra: object = {}) =>
	console.log(JSON.stringify({ run, stage, ...extra }));
const meter = () => readMeter(creds.account, creds.token, process.env.HOSTBOOT_METER_SINCE);
// strict mode stops at the first 5xx, failed or slow request; the guards stop on meter growth
const strict = process.env.HOSTBOOT_STRICT === '1';
const maxRequestMs = Number(process.env.HOSTBOOT_MAX_REQUEST_MS ?? 170_000);
const guardRows = Number(process.env.HOSTBOOT_GUARD_ROWS ?? Infinity);
const guardGbS = Number(process.env.HOSTBOOT_GUARD_GBS ?? Infinity);
const gateRounds = Number(process.env.HOSTBOOT_GATE_ROUNDS ?? 0);
const idleFrom = Number(process.env.HOSTBOOT_IDLE_FROM ?? 0);
let aborted: string | undefined;
let firstMeter: Meter | undefined;
let lastMeter: Meter | undefined;
let unreadable = 0;
const pick = (m: Meter) => ({
	rowsWritten: m.rowsWritten,
	durableObjectDurationGbS: Math.round(m.durableObjectDurationGbS * 100) / 100,
	durableObjectRequests: m.durableObjectRequests,
	workerRequests: m.workerRequests
});
const minus = (a: Meter, b: Meter) => ({
	rowsWritten: a.rowsWritten - b.rowsWritten,
	durableObjectDurationGbS:
		Math.round((a.durableObjectDurationGbS - b.durableObjectDurationGbS) * 100) / 100,
	durableObjectRequests: a.durableObjectRequests - b.durableObjectRequests,
	workerRequests: a.workerRequests - b.workerRequests
});

/** reads the meter, prints the running total and the deltas, and ends the run on growth or on two failed reads */
async function guard(stage: string, enforce = true) {
	const now = await meter();
	if (now.error) {
		unreadable++;
		log('meter-unreadable', { stage, error: now.error.slice(0, 120), unreadable });
		if (unreadable >= 2 && enforce) throw new Error('the meter was unreadable twice in a row');
		return now;
	}
	unreadable = 0;
	firstMeter ??= now;
	log('meter', {
		stage,
		total: pick(now),
		sinceFirst: minus(now, firstMeter),
		sinceLast: lastMeter ? minus(now, lastMeter) : null
	});
	lastMeter = now;
	const grown = minus(now, firstMeter);
	if (enforce && (grown.rowsWritten > guardRows || grown.durableObjectDurationGbS > guardGbS))
		throw new Error(`the meter grew past a guard at ${stage}`);
	return now;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const base64url = () =>
	Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url');

const key = base64url();
const salt = base64url();
const baseline = await snapshot(api);
save('baseline.json', baseline);
const inventoryBefore = await inventory(api);
save('inventory-before.json', inventoryBefore);
const meterStart = await guard('start');
save('meter-start.json', meterStart);
log('baseline', { workers: baseline.scripts.length, namespaces: baseline.namespaces.length });
log('budget', budget);

const subdomain = (await api('/workers/subdomain')).subdomain;
const workers: { arm: string; name: string; url: string; variant: string; tail?: Child }[] = [];
const rows: StepRow[] = [];
const idleTasks: Promise<void>[] = [];
const idleIntervals = [30, 90, 150, 90];
const spent = { rowsWritten: 0, requests: 0, perArm: {} as Record<string, number> };
const refusals: { arm: string; dir: string; text: string }[] = [];

async function get(arm: string, url: string, background = false) {
	spent.requests++;
	spent.perArm[arm] = (spent.perArm[arm] ?? 0) + 1;
	const began = performance.now();
	let result: { status: number; wallMs: number; text: string; error?: string };
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(strict ? maxRequestMs : 170_000)
		});
		const text = await response.text();
		result = { status: response.status, wallMs: performance.now() - began, text };
	} catch (error) {
		result = { status: 0, wallMs: performance.now() - began, text: '', error: String(error) };
	}
	const reason =
		result.status >= 500
			? `status ${result.status}`
			: result.status === 0
				? 'the request failed or ran past the time limit'
				: '';
	if (strict && reason) {
		aborted ??= `${arm}: ${reason}`;
		log('abort-request', { arm, reason, path: new URL(url).pathname });
		if (!background) throw new Error(`aborting: ${reason}`);
	}
	return result;
}

const json = (text: string): any => {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
};

async function deploy(arm: string, dir: string) {
	const name = `cfw-folio-hostboot-${arm}-${suffix}`;
	const file = `deploy-${arm}-${refusals.filter((r) => r.arm === arm).length}.log`;
	const child = spawnWrangler(
		creds,
		['deploy', '-c', 'wrangler.deploy.jsonc', '--name', name],
		new URL(file, directory),
		{ cwd: pathToFileURL(`${dir}/`) }
	);
	try {
		await child.done;
	} catch (error) {
		const text = readFileSync(new URL(file, directory), 'utf8').slice(-3000);
		refusals.push({ arm, dir, text });
		log('refused', { arm, exact: text.replace(/[a-z0-9-]+\.workers\.dev/g, '<host>') });
		return null;
	}
	const text = readFileSync(new URL(file, directory), 'utf8');
	log('deployed', { arm, name, ...parseDeployLog(text) });
	return { arm, name, url: `https://${name}.${subdomain}.workers.dev`, variant: dir };
}

let failure: unknown;
try {
	for (const { arm, dir, fallback } of arms) {
		let deployed = await deploy(arm, dir);
		if (!deployed && fallback) deployed = await deploy(arm, fallback);
		assert.ok(deployed, `${arm} deploy refused`);
		workers.push(deployed);
		await guard(`after-deploy-${arm}`);
	}
	for (const worker of workers) {
		let status = 0;
		for (let attempt = 0; attempt < 8 && status !== 200; attempt++) {
			const ready = await get(worker.arm, `${worker.url}/hostseed?site=ready&tag=ready`);
			status = ready.status;
			if (status !== 200) {
				log('not-ready', {
					arm: worker.arm,
					attempt,
					status,
					body: ready.text.slice(0, 200),
					error: ready.error
				});
				await pause(2500);
			}
		}
		assert.equal(status, 200, `${worker.arm} did not become ready`);
		worker.tail = spawnWrangler(
			creds,
			['tail', worker.name, '--format', 'json'],
			new URL(`tail-${worker.arm}.jsonl`, directory),
			{ cwd: directory }
		);
		void worker.tail.done.catch(() => {});
	}
	await pause(6000);

	for (let round = 0; round < rounds; round++) {
		if (aborted) throw new Error(`aborting: ${aborted}`);
		const order = [
			...workers.slice(round % workers.length),
			...workers.slice(0, round % workers.length)
		];
		for (const worker of order) {
			if (
				!withinBudget(budget, spent, worker.arm, process.env.HOSTBOOT_SERVE === '1' ? 8 : 6)
			) {
				log('stop', { reason: 'budget', spent });
				throw new Error('budget reached');
			}
			const object = `${worker.arm}-${round}-${suffix}`;
			const tag = `${worker.arm}${round}${suffix}`;
			const site = encodeURIComponent(object);
			for (let attempt = 0; attempt < 2; attempt++) {
				const r = await get(worker.arm, `${worker.url}/migrate?site=${site}&all=1`);
				const body = json(r.text);
				spent.rowsWritten += Number(body.rowsWritten ?? 0);
				rows.push({
					arm: worker.arm,
					object,
					kind: 'migrate',
					status: r.status,
					wallMs: r.wallMs,
					rowsWritten: Number(body.rowsWritten ?? 0),
					error: r.error
				});
			}
			const seed = await get(
				worker.arm,
				`${worker.url}/hostseed?site=${site}&key=${key}&salt=${salt}&tag=${tag}seed`
			);
			rows.push({
				arm: worker.arm,
				object,
				kind: 'seed',
				status: seed.status,
				wallMs: seed.wallMs
			});
			await pause(1500);
			const m = await get(
				worker.arm,
				`${worker.url}/hostbody?site=${site}&path=/&tag=${tag}`
			);
			const body = json(m.text);
			const run0 = body.php?.runs?.[0];
			rows.push({
				arm: worker.arm,
				object,
				kind: 'measure',
				tag,
				status: m.status,
				wallMs: m.wallMs,
				bytes: run0?.bytes,
				bodyHash: run0?.body ? bodyHash(run0.body) : undefined,
				warm: body.php?.warmInterpreter,
				baked: body.boot?.baked,
				error: m.error ?? body.php?.error,
				delivery: {
					moduleTag: body.boot?.moduleTag,
					objectTag: body.boot?.objectTag,
					bootCalls: body.boot?.bootCalls,
					crossings: body.crossings,
					phases: body.boot?.phases
				}
			});
			const c = await get(
				worker.arm,
				`${worker.url}/hostprobe?site=${site}&what=csrf&tag=${tag}csrf`
			);
			rows.push({
				arm: worker.arm,
				object,
				kind: 'csrf',
				status: c.status,
				token: json(c.text).probe?.token
			});
			if (process.env.HOSTBOOT_SERVE === '1') {
				// what the host does after an eviction: no interpreter, then an ordinary render
				await get(worker.arm, `${worker.url}/hostdrop?site=${site}&tag=${tag}x`);
				const stag = `${tag}s`;
				const sv = await get(
					worker.arm,
					`${worker.url}/hostbody?site=${site}&path=/&tag=${stag}`
				);
				const sj = json(sv.text);
				const srun = sj.php?.runs?.[0];
				rows.push({
					arm: `${worker.arm}-serve`,
					object,
					kind: 'measure',
					tag: stag,
					status: sv.status,
					wallMs: sv.wallMs,
					bytes: srun?.bytes,
					bodyHash: srun?.body ? bodyHash(srun.body) : undefined,
					warm: sj.php?.warmInterpreter,
					baked: sj.boot?.baked,
					error: sv.error ?? sj.php?.error,
					delivery: { crossings: sj.crossings, phases: sj.boot?.phases }
				});
			}
			if (process.env.HOSTBOOT_BOOTPHASE === '1') {
				// /bootphase drops the interpreter, so this is a re-boot of an object already served
				const rtag = `${tag}r`;
				const rb = await get(
					worker.arm,
					`${worker.url}/bootphase?site=${site}&phase=render&tag=${rtag}`
				);
				const rj = json(rb.text);
				rows.push({
					arm: `${worker.arm}-reboot`,
					object,
					kind: 'measure',
					tag: rtag,
					status: rb.status,
					wallMs: rb.wallMs,
					bytes: rj.result?.renderBytes,
					warm: rj.result?.alreadyBooted,
					baked: rj.hostboot?.baked,
					error: rb.error ?? rj.result?.error,
					delivery: {
						renderStatus: rj.result?.renderStatus,
						heapRestore: rj.heapRestore,
						crossings: rj.crossings,
						phases: rj.hostboot?.phases,
						heapBytes: rj.heapBytes
					}
				});
				if (round === 0 && worker.arm === 'control') {
					const st = await get(
						worker.arm,
						`${worker.url}/heap?site=${site}&op=status&tag=${tag}hs`
					);
					const sj = json(st.text);
					rows.push({
						arm: worker.arm,
						object,
						kind: 'phase',
						phase: 'heap-status',
						tag: `${tag}hs`,
						status: st.status,
						delivery: {
							heapRestore: sj.heapRestore,
							latest: sj.latest,
							imagedGeneration: sj.imagedGeneration,
							enabled: sj.enabled
						}
					});
				}
				if (round < Number(process.env.HOSTBOOT_PHASE_ROUNDS ?? 2)) {
					// the boot floor and the render apart: drop, boot only, then render on the warm interpreter
					for (const [phase, path, label] of [
						['drop', '/hostdrop', 'd'],
						['boot-only', '/php', 'p'],
						['render-warm', '/hostbody', 'b']
					] as const) {
						const ptag = `${tag}${label}`;
						const extra = path === '/hostbody' ? '&path=/' : '';
						const p = await get(
							worker.arm,
							`${worker.url}${path}?site=${site}${extra}&tag=${ptag}`
						);
						const pj = json(p.text);
						rows.push({
							arm: worker.arm,
							object,
							kind: 'phase',
							phase,
							tag: ptag,
							status: p.status,
							wallMs: p.wallMs,
							warm: pj.php?.warmInterpreter,
							delivery: {
								bootMs: pj.bootMs,
								baked: pj.boot?.baked,
								runMs: pj.php?.runs?.[0]?.ms
							}
						});
					}
				}
			}
			if (process.env.HOSTBOOT_IDLE === '1' && round >= idleFrom) {
				// one probe per object after its own idle interval; nothing else touches the object meanwhile
				const interval = idleIntervals[round % idleIntervals.length]!;
				const touched = Date.now();
				const first = rows.filter(
					(r) => r.object === object && r.arm === worker.arm && r.kind === 'measure'
				)[0]!;
				idleTasks.push(
					(async () => {
						await pause(interval * 1000);
						const itag = `${tag}i`;
						const r = await get(
							worker.arm,
							`${worker.url}/hostbody?site=${site}&path=/&tag=${itag}`,
							true
						);
						const b = json(r.text);
						rows.push({
							arm: worker.arm,
							object,
							kind: 'phase',
							phase: `idle-${interval}`,
							tag: itag,
							status: r.status,
							wallMs: r.wallMs,
							warm: b.php?.warmInterpreter,
							baked: b.boot?.baked,
							delivery: {
								idleMs: Date.now() - touched,
								moduleTag: b.boot?.moduleTag,
								objectTag: b.boot?.objectTag,
								bootCalls: b.boot?.bootCalls,
								moduleTagKept: b.boot?.moduleTag === first.delivery?.moduleTag,
								objectTagKept: b.boot?.objectTag === first.delivery?.objectTag,
								bootCallsFirst: first.delivery?.bootCalls
							}
						});
						log('idle', {
							arm: worker.arm,
							interval,
							warm: b.php?.warmInterpreter,
							status: r.status
						});
					})()
				);
			}
			log('object', {
				arm: worker.arm,
				round,
				status: m.status,
				wallMs: Math.round(m.wallMs),
				spent
			});
		}
		await guard(`round-${round}`);
		if (gateRounds && round === gateRounds - 1 && round < rounds - 1) {
			// continue to the larger n only when nothing failed and the baked serve path is faster
			await pause(15_000);
			const seen = Object.fromEntries(
				workers.map((w) => {
					let text = '';
					try {
						text = readFileSync(new URL(`tail-${w.arm}.jsonl`, directory), 'utf8');
					} catch {
						// no tail yet
					}
					return [w.arm, text];
				})
			);
			const partial = summarizeRun(rows, seen);
			const clean = Object.values<Record<string, number>>(partial.outcomes).every((o) =>
				Object.keys(o).every((k) => k === 'ok')
			);
			const serve = Object.entries<any>(partial.saving)
				.filter(([k]) => k.endsWith('-serve'))
				.map(([k, v]) => [k, v.cpuRatio] as const);
			const pass = clean && serve.length > 0 && serve.every(([, ratio]) => ratio < 1);
			log('gate', { pass, clean, serve, outcomes: partial.outcomes });
			if (!pass) break;
		}
	}
	await Promise.all(idleTasks);
	if (aborted) throw new Error(`aborting: ${aborted}`);
	if (process.env.HOSTBOOT_DELIVER === '1') {
		const worker = workers.find((w) => w.arm === 'baked')!;
		// a second and a third object on the same deploy; the third also hashes every page
		for (const [index, check] of [0, 0, 1].entries()) {
			const tag = `deliver${index}${suffix}`;
			const r = await get(
				worker.arm,
				`${worker.url}/hostdeliver?site=${tag}&check=${check}&tag=${tag}`
			);
			const body = json(r.text);
			rows.push({
				arm: worker.arm,
				object: tag,
				kind: 'deliver',
				tag,
				status: r.status,
				wallMs: r.wallMs,
				delivery: {
					check,
					instantiateMs: body.instantiateMs,
					totalMs: body.stats?.totalMs,
					indexMs: body.stats?.indexMs,
					fetchMs: body.stats?.fetchMs,
					copyMs: body.stats?.copyMs,
					pages: body.stats?.pages,
					memoryBytes: body.memoryBytes,
					checked: body.check
				}
			});
			log('deliver', {
				index,
				status: r.status,
				wallMs: Math.round(r.wallMs),
				total: body.stats?.totalMs
			});
		}
	}
	if (process.env.HOSTBOOT_REBOOT === '1') {
		// every object is idle past the 10 s hibernation threshold, which drops its interpreter
		await pause(30_000);
		const firsts = rows.filter((row) => row.kind === 'measure');
		for (const first of firsts) {
			if (!withinBudget(budget, spent, first.arm, 2)) throw new Error('budget reached');
			const worker = workers.find((w) => w.arm === first.arm)!;
			const tag = `${first.tag}r`;
			const m = await get(
				worker.arm,
				`${worker.url}/hostbody?site=${encodeURIComponent(first.object)}&path=/&tag=${tag}`
			);
			const body = json(m.text);
			const run0 = body.php?.runs?.[0];
			rows.push({
				arm: `${first.arm}-reboot`,
				object: first.object,
				kind: 'measure',
				tag,
				status: m.status,
				wallMs: m.wallMs,
				bytes: run0?.bytes,
				bodyHash: run0?.body ? bodyHash(run0.body) : undefined,
				warm: body.php?.warmInterpreter,
				baked: body.boot?.baked,
				error: m.error ?? body.php?.error
			});
			log('reboot', {
				arm: first.arm,
				status: m.status,
				wallMs: Math.round(m.wallMs),
				warm: body.php?.warmInterpreter
			});
		}
	}
	await pause(8000);
} catch (error) {
	failure = error;
	log('error', { message: String(error).slice(0, 400) });
} finally {
	for (const worker of workers) await stopTail(worker.tail);
	save('steps.json', rows);
	save('refusals.json', refusals);
	const tails = Object.fromEntries(
		workers.map((w) => {
			let text = '';
			try {
				text = readFileSync(new URL(`tail-${w.arm}.jsonl`, directory), 'utf8');
			} catch {
				// a Worker that never became ready has no tail file
			}
			return [w.arm, text];
		})
	);
	const summary = {
		run,
		budget,
		spent,
		variants: Object.fromEntries(workers.map((w) => [w.arm, w.variant.split('/').pop()])),
		...summarizeRun(rows, tails),
		failure: failure ? String(failure).slice(0, 300) : null
	} as any;
	save('summary.json', summary);
	log('summary', { arms: summary.arms, saving: summary.saving });
	for (const worker of workers) {
		if ((await snapshot(api)).scripts.includes(worker.name))
			await retire(api, worker.name, classes, { old: 'v2', next: 'v3' });
	}
	const after = await snapshot(api);
	save('after.json', after);
	const end = await guard('end', false);
	save('meter-end.json', end);
	const inventoryAfter = await inventory(api);
	save('inventory-after.json', inventoryAfter);
	const differences = inventoryDiff(inventoryBefore, inventoryAfter, (entry) =>
		[entry.name, entry.script].some((n) => String(n ?? '').startsWith('cfw-folio-hostboot-'))
	);
	log('inventory', {
		mine: differences.filter((d) => d.mine).length,
		foreign: differences.filter((d) => !d.mine)
	});
	assert.deepEqual(after, baseline, 'account resource baseline differs');
	log('cleanup', { baselineRestored: true });
}
