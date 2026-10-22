import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readMeter } from '../consumer/drive.ts';
import {
	createApi,
	credentials,
	retire,
	snapshot,
	spawnWrangler,
	stopTail,
	type Child
} from '../lib/cloudflare.ts';
import { parseDeployLog } from './analyze.ts';
import { bodyHash, summarizeRun, withinBudget, type Budget, type StepRow } from './s34-analyze.ts';

const arms = [
	{ arm: 'control', dir: process.env.S34_CONTROL_DIR! },
	{ arm: 'baked', dir: process.env.S34_BAKED_DIR!, fallback: process.env.S34_FALLBACK_DIR }
];
assert.ok(
	arms.every((a) => a.dir),
	'set S34_CONTROL_DIR and S34_BAKED_DIR'
);
const rounds = Number(process.env.S34_ROUNDS ?? 5);
const budget: Budget = { maxRowsWritten: 60_000, maxRequests: 500, maxRequestsPerArm: 40 };
const classes = ['SitePhpDurableObject', 'RenderLane'];

const creds = credentials();
const api = createApi(creds);
const suffix = crypto.randomUUID().slice(0, 8);
const run = `cfw-folio-s34-${suffix}`;
const directory = new URL(`./runs/${run}/`, import.meta.url);
mkdirSync(directory, { recursive: true });
const save = (file: string, value: unknown) =>
	writeFileSync(new URL(file, directory), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const log = (stage: string, extra: object = {}) =>
	console.log(JSON.stringify({ run, stage, ...extra }));
const meter = () => readMeter(creds.account, creds.token);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const base64url = () =>
	Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url');

const key = base64url();
const salt = base64url();
const baseline = await snapshot(api);
save('baseline.json', baseline);
const meterStart = await meter();
save('meter-start.json', meterStart);
log('meter-start', meterStart);
log('baseline', { workers: baseline.scripts.length, namespaces: baseline.namespaces.length });
log('budget', budget);

const subdomain = (await api('/workers/subdomain')).subdomain;
const workers: { arm: string; name: string; url: string; variant: string; tail?: Child }[] = [];
const rows: StepRow[] = [];
const spent = { rowsWritten: 0, requests: 0, perArm: {} as Record<string, number> };
const refusals: { arm: string; dir: string; text: string }[] = [];

async function get(arm: string, url: string) {
	spent.requests++;
	spent.perArm[arm] = (spent.perArm[arm] ?? 0) + 1;
	const began = performance.now();
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(170_000) });
		const text = await response.text();
		return { status: response.status, wallMs: performance.now() - began, text };
	} catch (error) {
		return { status: 0, wallMs: performance.now() - began, text: '', error: String(error) };
	}
}

const json = (text: string): any => {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
};

async function deploy(arm: string, dir: string) {
	const name = `cfw-folio-s34-${arm}-${suffix}`;
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
		log('meter-after-deploy', { arm, ...(await meter()) });
	}
	for (const worker of workers) {
		let status = 0;
		for (let attempt = 0; attempt < 4 && status !== 200; attempt++) {
			status = (await get(worker.arm, `${worker.url}/s34seed?site=ready&tag=ready`)).status;
			if (status !== 200) await pause(1500);
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
		const order = round % 2 ? [...workers].reverse() : workers;
		for (const worker of order) {
			if (!withinBudget(budget, spent, worker.arm, 6)) {
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
				`${worker.url}/s34seed?site=${site}&key=${key}&salt=${salt}&tag=${tag}seed`
			);
			rows.push({
				arm: worker.arm,
				object,
				kind: 'seed',
				status: seed.status,
				wallMs: seed.wallMs
			});
			await pause(1500);
			const m = await get(worker.arm, `${worker.url}/s34body?site=${site}&path=/&tag=${tag}`);
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
				error: m.error ?? body.php?.error
			});
			const c = await get(
				worker.arm,
				`${worker.url}/s34probe?site=${site}&what=csrf&tag=${tag}csrf`
			);
			rows.push({
				arm: worker.arm,
				object,
				kind: 'csrf',
				status: c.status,
				token: json(c.text).probe?.token
			});
			log('object', {
				arm: worker.arm,
				round,
				status: m.status,
				wallMs: Math.round(m.wallMs),
				spent
			});
		}
		log('meter-round', { round, ...(await meter()) });
	}
	if (process.env.S34_REBOOT === '1') {
		// every object is idle past the 10 s hibernation threshold, which drops its interpreter
		await pause(30_000);
		const firsts = rows.filter((row) => row.kind === 'measure');
		for (const first of firsts) {
			if (!withinBudget(budget, spent, first.arm, 2)) throw new Error('budget reached');
			const worker = workers.find((w) => w.arm === first.arm)!;
			const tag = `${first.tag}r`;
			const m = await get(
				worker.arm,
				`${worker.url}/s34body?site=${encodeURIComponent(first.object)}&path=/&tag=${tag}`
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
		workers.map((w) => [w.arm, readFileSync(new URL(`tail-${w.arm}.jsonl`, directory), 'utf8')])
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
	const end = await meter();
	save('meter-end.json', end);
	log('meter-end', end);
	assert.deepEqual(after, baseline, 'account resource baseline differs');
	log('cleanup', { baselineRestored: true });
}
