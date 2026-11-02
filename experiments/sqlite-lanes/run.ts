import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { median, PRICES } from '../concurrency/plan.ts';
import {
	createApi,
	credentials,
	inventory,
	inventoryDiff,
	retire,
	spawnWrangler,
	stopTail,
	type Child
} from '../lib/cloudflare.ts';
import {
	ARMS,
	CPU_SLACK,
	INVOCATION_CAP,
	objectCalls,
	plan,
	PREFIX,
	QUERIES,
	READY_PROBES,
	REPS,
	schedule,
	SERIAL_PARTS,
	usd,
	WARMUPS,
	type Arm,
	type Cell
} from './plan.ts';
import { FIXTURE_DIR, readManifest, type Manifest } from './prepare.ts';
import { shasOf, shipments, type Shipment } from './ship.ts';

const workersCompatibility = '2026-10-20';

class CapReached extends Error {}
class Wedged extends Error {}

/** The plan as the text a dry run prints. */
export function describePlan(reps = REPS, warmups = WARMUPS) {
	const p = plan(reps, warmups);
	const manifest = existsSync(join(FIXTURE_DIR, 'manifest.json')) ? readManifest() : undefined;
	const uploaded = manifest
		? [manifest.whole, ...Object.values(manifest.sets).flat()].reduce((s, a) => s + a.bytes, 0)
		: undefined;
	return [
		'dry run: nothing is deployed and no Cloudflare call is made',
		`deploys: 1 Worker script with ${p.objectNames} ShardObject names (1 serial, 4 shards, 8 shards), deleted at the end`,
		`cells: ${p.cellsPerRep} a repetition (${QUERIES.length} queries x ${ARMS.length} arms), ${reps} repetitions after ${warmups} warmups, arms interleaved`,
		`uploads: whole table in ${SERIAL_PARTS} parts, then each shard once${uploaded === undefined ? ' (fixture not built; run prepare.ts)' : `: ${uploaded} bytes in total`}`,
		`invocations: ${p.expected} planned against a cap of ${p.cap} (${p.withinCap ? 'within the cap' : 'OVER THE CAP, the run refuses to start'})`,
		`top-level requests ${p.topLevel}; Durable Object calls ${p.objects}; readiness at most ${READY_PROBES}`,
		`Durable Object duration, assumed active the whole run: ${p.counts.durableObjectGbSeconds.toFixed(1)} GB-s (assumption, not a measurement)`,
		`cpu at most ${p.counts.cpuMs} ms (Mac medians times ${CPU_SLACK}; not measured on the platform)`,
		`list-rate price, no monthly allowance applied (read ${PRICES.read}):`,
		`  worker requests ${usd(p.price.usd.workerRequests)}, cpu ${usd(p.price.usd.cpu)}, Durable Object requests ${usd(p.price.usd.durableObjectRequests)}, Durable Object duration ${usd(p.price.usd.durableObjectDuration)}`,
		`  total at most ${usd(p.price.total)}`,
		'repetition 0 order:',
		...schedule(0).map(
			(c: Cell) => `  ${c.query} ${c.arm} (${objectCalls(c.arm)} object calls)`
		)
	];
}

async function live() {
	const reps = Number(process.env.FOLIO_SQLITE_LANES_REPS ?? REPS);
	const p = plan(reps);
	assert.ok(p.withinCap, `planned ${p.expected} invocations exceed the cap of ${INVOCATION_CAP}`);
	const creds = credentials({
		FOLIO_CLOUDFLARE_ACCOUNT_ID: process.env.FOLIO_CLOUDFLARE_ACCOUNT_ID,
		FOLIO_CLOUDFLARE_API_TOKEN: process.env.FOLIO_CLOUDFLARE_API_TOKEN
	});
	const api = createApi(creds);
	execFileSync(process.execPath, ['experiments/sqlite-lanes/prepare.ts'], { stdio: 'pipe' });
	const manifest: Manifest = readManifest();
	const parts = shipments(manifest, FIXTURE_DIR);
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
		priced: { counts: p.counts, price: p.price },
		fixture: {
			rows: manifest.rows,
			sqlite: manifest.sqlite,
			whole: { bytes: manifest.whole.bytes, sha256: manifest.whole.sha256 },
			sets: Object.fromEntries(
				Object.entries(manifest.sets).map(([k, v]) => [k, v.map((a) => a.sha256)])
			)
		}
	});
	log('baseline', { scripts: baseline.scripts?.length ?? null });

	const subdomain = (await api('/workers/subdomain')).subdomain;
	const base = `https://${name}.${subdomain}.workers.dev`;
	const headers = { authorization: `Bearer ${secret}` };
	const tails: Child[] = [];
	const samples: Record<string, unknown>[] = [];
	const loads: Record<string, unknown>[] = [];
	let spent = 0;
	let streak = 0;
	const charge = (n: number) => {
		if (spent + n > INVOCATION_CAP) throw new CapReached('invocation cap reached');
		spent += n;
	};

	async function get(
		url: string,
		init: { method?: string; body?: Uint8Array<ArrayBuffer> } = {},
		timeout = 60000
	) {
		let status: number | null = null;
		let body: any = null;
		let error: string | undefined;
		try {
			const response = await fetch(url, {
				...init,
				headers,
				signal: AbortSignal.timeout(timeout)
			});
			status = response.status;
			const text = await response.text();
			try {
				body = JSON.parse(text);
			} catch {
				error = text.slice(0, 500);
			}
		} catch (caught) {
			error = String((caught as Error)?.message ?? caught).slice(0, 500);
		}
		return { status, body, error };
	}

	// one owner request and one object call per part; a failed load stops the run
	async function load(part: Shipment) {
		charge(2);
		const query = new URLSearchParams({
			run: name,
			set: part.set,
			slot: String(part.slot),
			sha: part.sha256,
			total: String(part.total),
			offset: String(part.offset),
			partSha: part.partSha256
		});
		const began = performance.now();
		const result = await get(
			`${base}/load?${query}`,
			{ method: 'POST', body: part.bytes },
			600000
		);
		const row = {
			set: part.set,
			slot: part.slot,
			offset: part.offset,
			bytes: part.bytes.length,
			status: result.status,
			error: result.error,
			clientWallMs: performance.now() - began
		};
		loads.push(row);
		await appendFile(new URL('loads.jsonl', directory), `${JSON.stringify(row)}\n`);
		if (result.status !== 200) throw new Error(`load failed: ${JSON.stringify(row)}`);
	}

	async function runArm(arm: Arm | 'reference', query: string) {
		const objects = arm === 'reference' ? 1 : objectCalls(arm);
		charge(1 + objects);
		const shas = shasOf(manifest, arm === 'reference' ? 'serial' : arm);
		const params = new URLSearchParams({
			run: name,
			arm,
			query,
			rows: String(manifest.rows),
			shas: shas.join(',')
		});
		const began = performance.now();
		let result = await get(`${base}/run?${params}`);
		let reloads = 0;
		if (result.status === 409 && result.body?.miss) {
			reloads = result.body.miss.length;
			for (const part of parts)
				if (
					part.set === (arm === 'reference' ? 'serial' : arm) &&
					result.body.miss.includes(part.slot)
				)
					await load(part);
			charge(1 + objects);
			result = await get(`${base}/run?${params}`);
		}
		return { result, reloads, clientWallMs: performance.now() - began };
	}

	const reference = new Map<string, string>();
	let finished = 'complete';
	let deployed = false;
	try {
		const config = new URL(`wrangler.${name}.jsonc`, directory);
		await writeFile(
			config,
			JSON.stringify({
				name,
				main: '../../coordinator.ts',
				compatibility_date: workersCompatibility,
				workers_dev: true,
				durable_objects: { bindings: [{ name: 'SHARDS', class_name: 'ShardObject' }] },
				migrations: [{ tag: 'v1', new_classes: ['ShardObject'] }]
			})
		);
		deployed = true;
		await wrangler(
			['deploy', '--config', config.pathname, '--name', name],
			`deploy-${name}.log`
		);
		await wrangler(
			['secret', 'put', 'PROBE_TOKEN', '--name', name, '--config', config.pathname],
			`secret-${name}.log`,
			`${secret}\n`
		);

		// a fresh workers.dev route can answer 404 or 401 for a while; 200 means the route is live
		let status: number | null = null;
		for (let attempt = 0; attempt < READY_PROBES && status !== 200; attempt++) {
			charge(1);
			status = (await get(`${base}/ready`, {}, 30000)).status;
			if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 1500));
		}
		assert.equal(status, 200, 'route not ready');
		tails.push(
			spawnWrangler(
				creds,
				['tail', name, '--format', 'json'],
				new URL(`tail-${name}.jsonl`, directory),
				{ cwd: root }
			)
		);
		for (const tail of tails) void tail.done.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 5000));
		log('ready');

		for (const part of parts) await load(part);
		log('loaded', { parts: parts.length });

		for (const query of QUERIES) {
			const { result } = await runArm('reference', query);
			assert.equal(
				result.status,
				200,
				`reference ${query}: ${result.error ?? JSON.stringify(result.body)}`
			);
			reference.set(query, result.body.calls[0].text);
		}
		await save('reference.json', Object.fromEntries(reference));

		for (let rep = -WARMUPS; rep < reps; rep++)
			for (const cell of schedule(rep)) {
				const { result, reloads, clientWallMs } = await runArm(cell.arm, cell.query);
				const calls = result.body?.calls ?? [];
				const got = cell.arm === 'serial' ? calls[0]?.text : result.body?.merged;
				const equal = result.status === 200 && got === reference.get(cell.query);
				const sample = {
					rep,
					query: cell.query,
					arm: cell.arm,
					status: result.status,
					reloads,
					equal,
					warm: calls.every((c: { warm: boolean }) => c.warm),
					vmSteps: calls.map((c: { vmSteps: number }) => c.vmSteps),
					clientWallMs,
					error: result.error
				};
				streak = equal ? 0 : streak + 1;
				await appendFile(
					new URL('requests.jsonl', directory),
					`${JSON.stringify(sample)}\n`
				);
				if (rep >= 0) samples.push(sample);
				log('cell', {
					rep,
					query: cell.query,
					arm: cell.arm,
					equal,
					ms: Math.round(clientWallMs)
				});
				if (streak >= 8) throw new Wedged(`${streak} failed cells in a row`);
			}
	} catch (error) {
		if (error instanceof CapReached) finished = 'cap';
		else if (error instanceof Wedged) finished = 'wedged';
		else finished = `failed: ${(error as Error).message}`;
		log('stopped', { finished });
	} finally {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		for (const tail of tails) await stopTail(tail);
		const present = async () =>
			(await api('/workers/scripts')).map((row: { id: string }) => row.id);
		if (deployed && (await present()).includes(name)) {
			try {
				await retire(api, name, ['ShardObject']);
			} catch {
				await api(`/workers/scripts/${name}`, { method: 'DELETE' }).catch(() => {});
			}
		}
		const after = await inventory(api);
		await save('after.json', after);
		// foreign changes belong to other users of the account; they are recorded and never touched
		const changes = inventoryDiff(baseline, after, mine);
		const leftovers = changes.filter((change) => change.mine);
		const foreignChanges = changes.filter((change) => !change.mine);
		const byCell = new Map<string, number[]>();
		for (const s of samples) {
			const key = `${s.query}/${s.arm}`;
			byCell.set(key, [...(byCell.get(key) ?? []), s.clientWallMs as number]);
		}
		await save('samples.json', samples);
		await save('summary.json', {
			finished,
			invocations: spent,
			samples: samples.length,
			mismatches: samples.filter((s) => !s.equal).length,
			coldWarmViolations: samples.filter((s) => !s.warm).length,
			medianClientMs: Object.fromEntries(
				[...byCell].map(([k, v]) => [k, Number(median(v).toFixed(1))])
			),
			leftovers,
			foreignChanges
		});
		log('cleanup', {
			leftovers: leftovers.length,
			foreignChanges: foreignChanges.length,
			spent,
			finished
		});
		assert.equal(
			leftovers.length,
			0,
			`own resources left behind: ${JSON.stringify(leftovers)}`
		);
	}
}

if (import.meta.main) {
	if (process.argv.includes('--dry-run'))
		console.log(describePlan(Number(process.env.FOLIO_SQLITE_LANES_REPS ?? REPS)).join('\n'));
	else await live();
}
