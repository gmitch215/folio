import { readFile, writeFile } from 'node:fs/promises';
import {
	createApi,
	credentials,
	snapshot,
	spawnWrangler,
	stopTail,
	type Api,
	type Credentials
} from '../../lib/cloudflare.ts';

// one arm per run: `node run.ts <arm>`; deployed arms need the account variables (see README)
const arm = process.argv[2] ?? '';
const root = new URL('../../../', import.meta.url);
const runs = new URL('./runs/', import.meta.url);
const config = 'experiments/continuation/signal/wrangler.jsonc';
const worker = 'folio-continuation-signal';
const sizes = [2000, 5000, 10000, 20000, 40000];

const A = 6364136223846793005n;
const C = 1442695040888963407n;
const M = 1n << 64n;

// state after `blocks` blocks from seed 0 by affine jump-ahead; checked against direct iteration
function lcgAfter(blocks: number): string {
	let m = BigInt(blocks) * 1000000n;
	let ra = 1n;
	let rc = 0n;
	let ba = A;
	let bc = C;
	while (m > 0n) {
		if (m & 1n) [ra, rc] = [(ba * ra) % M, (ba * rc + bc) % M];
		[ba, bc] = [(ba * ba) % M, (ba * bc + bc) % M];
		m >>= 1n;
	}
	return String(BigInt.asIntN(64, rc));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid8 = () => crypto.randomUUID().slice(0, 8);
const save = (file: string, value: unknown) =>
	writeFile(new URL(file, runs), `${JSON.stringify(value, null, 2)}\n`);
const load = async (file: string) => JSON.parse(await readFile(new URL(file, runs), 'utf8'));
const median = (values: number[]) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const p90 = (values: number[]) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]!;
};

let base = process.env.WORKER_URL ?? '';
let creds: Credentials | undefined;
let api: Api | undefined;

async function cloud() {
	creds = credentials();
	api = createApi(creds);
	if (!base) {
		const subdomain = (await api('/workers/subdomain')).subdomain;
		base = `https://${worker}.${subdomain}.workers.dev`;
	}
}

async function call(path: string) {
	const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(180000) });
	const text = await response.text();
	let body: any;
	try {
		body = JSON.parse(text);
	} catch {
		body = text.slice(0, 300);
	}
	return { path, status: response.status, body };
}

async function safeCall(path: string): Promise<{ path: string; status: number; body: any }> {
	try {
		return await call(path);
	} catch (error) {
		return { path, status: 0, body: String(error) };
	}
}

// the wrangler tail is the only CPU record; its per-event cpuTime and outcome are joined to our logs
async function withTail<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const tail = spawnWrangler(
		creds!,
		['tail', '--config', config, '--format', 'json'],
		new URL(`${name}-tail.jsonl`, runs),
		{ cwd: root }
	);
	tail.done.catch(() => {});
	await sleep(8000);
	try {
		return await fn();
	} finally {
		await sleep(5000);
		await stopTail(tail);
	}
}

interface Call {
	object: string;
	blocks: number;
	rid: string;
	status: number;
	body: any;
	tail?: TailEvent | null;
}

interface TailEvent {
	outcome: string;
	cpuTime: number;
	wallTime: number;
	eventTimestamp: number;
}

const parseOrNull = (text: string) => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

// wrangler tail --format json prints pretty-printed objects back to back, not one per line
function splitObjects(text: string): any[] {
	const out: any[] = [];
	let depth = 0;
	let inString = false;
	let start = -1;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === '\\') i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{') {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) out.push(parseOrNull(text.slice(start, i + 1)));
		}
	}
	return out;
}

async function tailEvents(name: string) {
	const text = await readFile(new URL(`${name}-tail.jsonl`, runs), 'utf8');
	const byKey = new Map<string, TailEvent>();
	const byRid = new Map<string, TailEvent>();
	let exceeded = 0;
	let total = 0;
	for (const event of splitObjects(text)) {
		if (!event || typeof event !== 'object' || !('outcome' in event)) continue;
		total++;
		if (event.outcome === 'exceededCpu') exceeded++;
		const row: TailEvent = {
			outcome: event.outcome,
			cpuTime: event.cpuTime,
			wallTime: event.wallTime,
			eventTimestamp: event.eventTimestamp
		};
		for (const entry of event.logs ?? []) {
			for (const part of entry.message ?? []) {
				const note = typeof part === 'string' ? parseOrNull(part) : part;
				if (note?.tag !== 'ev') continue;
				byKey.set(`${note.isolate}:${note.ordinal}`, row);
				if (note.rid) byRid.set(note.rid, row);
			}
		}
	}
	return { byKey, byRid, exceeded, total };
}

const attach = <T extends { body: any; rid?: string }>(
	row: T,
	events: Awaited<ReturnType<typeof tailEvents>>
) => {
	const tail =
		(row.rid && events.byRid.get(row.rid)) ||
		(row.body?.isolate && events.byKey.get(`${row.body.isolate}:${row.body.ordinal}`)) ||
		null;
	return Object.assign(row, { tail });
};

async function a0() {
	base = 'http://127.0.0.1:8787';
	const object = `a0-${uuid8()}`;
	const started = await call(`/obj/${object}/chain?blocks=2000&mode=jspi&every=50`);
	let body: any;
	for (let poll = 0; poll < 240; poll++) {
		await sleep(2000);
		body = (await call(`/obj/${object}/status`)).body;
		if (body.job?.finished) break;
	}
	const job = body.job;
	const result = {
		arm: 'a0',
		local: true,
		startStatus: started.status,
		finished: job?.finished === 1,
		error: job?.error ?? null,
		final: job?.final ?? null,
		expected: lcgAfter(2000),
		finalMatch: job?.final === lcgAfter(2000),
		slices: body.slices.length,
		sliceBlocks: body.slices.map((s: any) => s.blocks),
		hasStackAtEnd: body.hasStack,
		jspi: body.jspi,
		pass: job?.finished === 1 && job?.final === lcgAfter(2000) && body.slices.length === 40
	};
	await save('a0.json', { ...result, slices: body.slices });
	console.log(JSON.stringify({ ...result, slices: undefined }));
}

async function snap(file: string) {
	await cloud();
	const shot = await snapshot(api!);
	await save(file, shot);
	console.log(
		JSON.stringify({
			file,
			scripts: shot.scripts.length,
			namespaces: shot.namespaces.length,
			kvReadable: shot.kv !== null,
			r2Readable: shot.r2 !== null,
			d1Readable: shot.d1 !== null,
			probeScriptPresent: shot.scripts.includes(worker)
		})
	);
}

// a1-analyze re-joins the stored calls to the stored tail without new events
async function a1() {
	const reuse = arm === 'a1-analyze';
	if (!reuse) await cloud();
	const stored = reuse ? await load('a1.json') : undefined;
	const objects: string[] = reuse ? stored.objects : [0, 1, 2].map((i) => `a1-${uuid8()}-${i}`);
	const rows = reuse
		? stored.calls
		: await withTail('a1', () =>
				Promise.all(
					objects.map(async (object) => {
						const out: any[] = [];
						for (const blocks of sizes) {
							const rid = crypto.randomUUID();
							const r = await safeCall(
								`/obj/${object}/burn?blocks=${blocks}&poll=0&rid=${rid}`
							);
							out.push({ object, blocks, rid, ...r });
							if (r.status !== 200) break;
						}
						return out;
					})
				)
			);
	const events = await tailEvents('a1');
	const flat: Call[] = rows.flat().map((row: Call) => attach(row, events));
	const perObject = objects.map((object) => {
		const mine = flat.filter((row) => row.object === object);
		const ok = mine.filter((row) => row.status === 200);
		const failed = mine.filter((row) => row.status !== 200);
		const last = ok.at(-1);
		const rate = last?.tail ? last.body.blocksDone / last.tail.cpuTime : null;
		return {
			events: mine.length,
			okBlocks: ok.map((row) => row.blocks),
			okCpuMs: ok.map((row) => row.tail?.cpuTime ?? null),
			blocksPerCpuSecond: ok.map((row) =>
				row.tail ? Math.round((row.body.blocksDone / row.tail.cpuTime) * 1000) : null
			),
			failedAt: failed[0]?.blocks ?? null,
			failedStatus: failed[0]?.status ?? null,
			failedOutcome: failed[0]?.tail?.outcome ?? null,
			failedCpuMs: failed[0]?.tail?.cpuTime ?? null,
			ratePerMs: rate,
			isolates: [...new Set(mine.map((row) => row.body?.isolate))].length
		};
	});
	const hit = perObject.filter((o) => o.failedAt !== null);
	if (!hit.length) throw new Error('no CPU-limit outcome up to 40000 blocks; stop and report');
	const limitBlocks = median(hit.map((o) => o.ratePerMs! * o.failedCpuMs!));
	const result = {
		arm: 'a1',
		objects,
		perObject,
		exceededInTail: (await tailEvents('a1')).exceeded,
		tailEvents: events.total,
		limitBlocks,
		limitCpuMs: median(hit.map((o) => o.failedCpuMs!)),
		limitNFail: hit.map((o) => o.failedAt),
		calls: flat
	};
	await save('a1.json', result);
	console.log(
		JSON.stringify({
			limitBlocks,
			limitCpuMs: result.limitCpuMs,
			hit: hit.length,
			of: objects.length,
			exceededInTail: result.exceededInTail,
			tailEvents: events.total
		})
	);
}

async function a2() {
	await cloud();
	const N = 4 * Math.round((await load('a1.json')).limitBlocks);
	const objects = Array.from({ length: 10 }, (_, i) => `a2-${uuid8()}-${i}`);
	const rows = await withTail('a2', () =>
		Promise.all(
			objects.map(async (object) => {
				const out: any[] = [];
				for (let event = 1; event <= 3; event++) {
					const rid = crypto.randomUUID();
					const r = await safeCall(`/obj/${object}/burn?blocks=${N}&poll=1&rid=${rid}`);
					out.push({ object, event, blocks: N, rid, ...r });
				}
				return out;
			})
		)
	);
	const events = await tailEvents('a2');
	const flat = rows.flat().map((row) => attach(row, events));
	const signaled = flat.filter((row) => row.status === 200 && row.body.blocksDone < N);
	const result = {
		arm: 'a2',
		N,
		events: flat.length,
		fired: signaled.length,
		firedFreshWord: signaled.filter((row) => row.body.before1024 === 0).length,
		exceededInTail: events.exceeded,
		calls: flat
	};
	await save('a2.json', result);
	console.log(
		JSON.stringify({
			N,
			events: flat.length,
			fired: result.fired,
			firedFreshWord: result.firedFreshWord,
			exceededInTail: result.exceededInTail
		})
	);
}

async function a3() {
	await cloud();
	const a1 = await load('a1.json');
	const targets = a1.calls.filter((row: any) => row.status === 200);
	const perObject = a1.objects.map((object: string) => {
		const mine = targets.filter((row: any) => row.object === object);
		const before = mine.at(-1);
		const failed = a1.calls.some((row: any) => row.object === object && row.status !== 200);
		return { object, failed, lastIsolate: before?.body?.isolate ?? null };
	});
	const readings: any[] = [];
	const withTailRun = await withTail('a3', async () => {
		for (const row of perObject.filter((o: any) => o.failed)) {
			const rid = crypto.randomUUID();
			const r = await safeCall(`/obj/${row.object}/burn?blocks=1&poll=0&rid=${rid}`);
			readings.push({
				object: row.object,
				rid,
				status: r.status,
				body: r.body,
				lastIsolate: row.lastIsolate
			});
		}
	});
	void withTailRun;
	const events = await tailEvents('a3');
	const out = readings.map((row) => ({
		...attach(row, events),
		isolateChanged: row.body?.isolate !== undefined && row.body.isolate !== row.lastIsolate
	}));
	await save('a3.json', { arm: 'a3', readings: out });
	console.log(
		JSON.stringify(
			out.map((row) => ({
				status: row.status,
				before1028: row.body?.before1028 ?? null,
				isolateChanged: row.isolateChanged,
				outcome: row.tail?.outcome ?? null
			}))
		)
	);
}

async function runChains(
	arm: string,
	specs: { object: string; mode: string; every: number }[],
	N: number,
	timeoutMs: number
) {
	const started = await Promise.all(
		specs.map((s) =>
			safeCall(`/obj/${s.object}/chain?blocks=${N}&mode=${s.mode}&every=${s.every}`)
		)
	);
	const polls: any[] = [];
	const last = new Map<string, any>();
	const t0 = Date.now();
	const withPolls = await withTail(arm, async () => {
		while (true) {
			await sleep(30000);
			const rows = await Promise.all(specs.map((s) => safeCall(`/obj/${s.object}/status`)));
			rows.forEach((row, i) => {
				last.set(specs[i]!.object, row.body);
				polls.push({
					t: Date.now() - t0,
					mode: specs[i]!.mode,
					every: specs[i]!.every,
					status: row.status,
					done: row.body?.job?.done ?? null,
					finished: row.body?.job?.finished ?? null,
					slices: row.body?.slices?.length ?? null
				});
			});
			const finished = specs.every((s) => last.get(s.object)?.job?.finished === 1);
			if (finished || Date.now() - t0 > timeoutMs) break;
		}
	});
	void withPolls;
	return { started, polls, last };
}

function chainSummary(specs: { object: string }[], last: Map<string, any>, events: any, N: number) {
	const expected = lcgAfter(N);
	return specs.map(({ object }) => {
		const body = last.get(object);
		const job = body?.job;
		const slices = (body?.slices ?? []).map((s: any) => ({
			...s,
			tail: events.byKey.get(`${s.isolate}:${s.ordinal}`) ?? null
		}));
		return {
			object,
			mode: job?.mode,
			every: job?.every,
			target: N,
			done: job?.done,
			finished: job?.finished === 1,
			error: job?.error ?? null,
			finalMatch: job?.final === expected,
			slices: slices.length,
			isolates: new Set(slices.map((s: any) => s.isolate)).size,
			isolateChanges: slices
				.slice(1)
				.filter((s: any, i: number) => s.isolate !== slices[i].isolate).length,
			exceeded: slices.filter((s: any) => s.tail?.outcome === 'exceededCpu').length,
			cpuMs: slices.map((s: any) => s.tail?.cpuTime ?? null),
			blocks: slices.map((s: any) => s.blocks),
			gapsMs: slices.slice(1).map((s: any, i: number) => s.start - slices[i].end),
			slicesDetail: slices.map((s: any) => ({
				k: s.k,
				blocks: s.blocks,
				before1024: s.before1024,
				startMs: s.start,
				endMs: s.end,
				cpuMs: s.tail?.cpuTime ?? null,
				outcome: s.tail?.outcome ?? null
			}))
		};
	});
}

async function chainArm(name: string, specs: { object: string; mode: string; every: number }[]) {
	await cloud();
	const N = 4 * Math.round((await load('a1.json')).limitBlocks);
	const { started, polls, last } = await runChains(name, specs, N, 30 * 60 * 1000);
	const events = await tailEvents(name);
	const summary = chainSummary(specs, last, events, N);
	const result = {
		arm: name,
		N,
		startStatus: started.map((row) => row.status),
		polls,
		exceededInTail: events.exceeded,
		tailEvents: events.total,
		chains: summary
	};
	await save(`${name}.json`, result);
	console.log(
		JSON.stringify({
			N,
			chains: summary.map(
				({
					mode,
					every,
					finished,
					finalMatch,
					slices,
					isolates,
					isolateChanges,
					exceeded,
					error,
					done
				}) => ({
					mode,
					every,
					finished,
					finalMatch,
					done,
					slices,
					isolates,
					isolateChanges,
					exceeded,
					error
				})
			),
			exceededInTail: events.exceeded
		})
	);
}

async function a4() {
	const objects = [0, 1, 2].map((i) => `a4-${uuid8()}-${i}`);
	await chainArm(
		'a4',
		objects.map((object) => ({ object, mode: 'sync', every: 0 }))
	);
}

async function a5() {
	const objects = [0, 1, 2].map((i) => `a5-${uuid8()}-${i}`);
	const handoff = `a5h-${uuid8()}`;
	await chainArm('a5', [
		...objects.map((object) => ({ object, mode: 'jspi', every: 0 })),
		{ object: handoff, mode: 'jspi', every: 100 }
	]);
}

const arms: Record<string, () => Promise<void>> = {
	a0,
	a1,
	'a1-analyze': a1,
	a2,
	a3,
	a4,
	a5,
	'snap-before': () => snap('snapshot-before.json'),
	'snap-after': () => snap('snapshot-after.json')
};

const run = arms[arm];
if (!run) throw new Error(`unknown arm: ${arm}`);
await run();
