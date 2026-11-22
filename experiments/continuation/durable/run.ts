import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const config = 'experiments/continuation/durable/wrangler.jsonc';
const worker = 'folio-continuation-durable';
// D1: four times the steps that fit in 30 s (about 30,000 at roughly 1 ms per step)
const BURN_BUDGET = 120000;
// D3 and D4: about 120 s of CPU at roughly 1 ms per step
const CHAIN_STEPS = 120000;
const LOCAL_STEPS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid8 = () => crypto.randomUUID().slice(0, 8);
const save = async (file: string, value: unknown) => {
	await mkdir(runs, { recursive: true });
	await writeFile(new URL(file, runs), `${JSON.stringify(value, null, 2)}\n`);
};
const load = async (file: string) => JSON.parse(await readFile(new URL(file, runs), 'utf8'));
const median = (values: number[]) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

let base = process.env.WORKER_URL ?? '';
let local = base.startsWith('http://127.0.0.1');
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
	const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(300000) });
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

// the wrangler tail is the only CPU record for deployed arms; local arms have none
async function withTail<T>(name: string, fn: () => Promise<T>): Promise<T> {
	if (local) return fn();
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

const parseOrNull = (text: string) => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

interface TailRow {
	outcome: string;
	cpuTime: number;
	isolate?: string;
	notes: any[];
}

async function tailEvents(name: string) {
	const byKey = new Map<string, TailRow>();
	const byRid = new Map<string, TailRow>();
	const outcomes: Record<string, number> = {};
	if (local) return { byKey, byRid, outcomes };
	const text = await readFile(new URL(`${name}-tail.jsonl`, runs), 'utf8');
	for (const event of splitObjects(text)) {
		if (!event || typeof event !== 'object' || !('outcome' in event)) continue;
		outcomes[event.outcome] = (outcomes[event.outcome] ?? 0) + 1;
		const row: TailRow = { outcome: event.outcome, cpuTime: event.cpuTime, notes: [] };
		for (const entry of event.logs ?? []) {
			for (const part of entry.message ?? []) {
				const note = typeof part === 'string' ? parseOrNull(part) : part;
				if (note?.tag !== 'ev') continue;
				row.isolate = note.isolate;
				row.notes.push(note);
				byKey.set(`${note.isolate}:${note.ordinal}`, row);
				if (note.rid) byRid.set(note.rid, row);
			}
		}
	}
	return { byKey, byRid, outcomes };
}

type Events = Awaited<ReturnType<typeof tailEvents>>;

const attach = <T extends { body: any; rid?: string }>(row: T, events: Events) => {
	const tail =
		(row.rid && events.byRid.get(row.rid)) ||
		(row.body?.isolate && events.byKey.get(`${row.body.isolate}:${row.body.ordinal}`)) ||
		null;
	return Object.assign(row, { tail });
};

async function snap(file: string) {
	await cloud();
	const shot = await snapshot(api!);
	await save(file, shot);
	console.log(
		JSON.stringify({
			file,
			scripts: shot.scripts.length,
			namespaces: shot.namespaces.length,
			probeScriptPresent: shot.scripts.includes(worker),
			probeNamespacePresent: shot.namespaces.length > 0 && shot.scripts.includes(worker)
		})
	);
}

// D0 and D1 burns are not chains; this is the D1 signal reading
async function d1() {
	await cloud();
	const objects = Array.from({ length: 10 }, (_, i) => `d1-${uuid8()}-${i}`);
	const rows = await withTail('d1', () =>
		Promise.all(
			objects.map(async (object) => {
				const out: any[] = [
					{ object, event: 1, ...(await safeCall(`/obj/${object}/init`)) }
				];
				for (let event = 2; event <= 4; event++) {
					const rid = crypto.randomUUID();
					const r = await safeCall(`/obj/${object}/burn?steps=${BURN_BUDGET}&rid=${rid}`);
					out.push({ object, event, rid, ...r });
				}
				return out;
			})
		)
	);
	const events = await tailEvents('d1');
	const calls = rows.flat().map((row) => attach(row, events));
	const table = calls
		.filter((row) => row.event > 1)
		.map((row) => ({
			object: row.object,
			event: row.event,
			status: row.status,
			ran: row.body?.ran ?? null,
			before1024: row.body?.before1024 ?? null,
			after1024: row.body?.after1024 ?? null,
			isolate: row.body?.isolate ?? null,
			outcome: row.tail?.outcome ?? null,
			cpuMs: row.tail?.cpuTime ?? null,
			stoppedOnSignal:
				row.status === 200 && row.body?.ran < BURN_BUDGET && row.body?.after1024 !== 0
		}));
	const stopped = table.filter((r) => r.stoppedOnSignal).length;
	const reset = table.filter((r) => r.status !== 200 || r.outcome !== 'ok').length;
	const reading = stopped >= 27 && reset === 0 ? 'A' : stopped > 0 ? 'B' : 'C';
	await save('d1.json', {
		arm: 'd1',
		objects,
		budget: BURN_BUDGET,
		table,
		stopped,
		reset,
		reading,
		outcomes: events.outcomes,
		calls
	});
	console.log(
		JSON.stringify({ events: table.length, stopped, reset, reading, outcomes: events.outcomes })
	);
}

async function d2() {
	await cloud();
	const objects = [0, 1, 2].map((i) => `d2-${uuid8()}-${i}`);
	const rows = await withTail('d2', () =>
		Promise.all(
			objects.map(async (object) => {
				const burnRid = crypto.randomUUID();
				const burn = {
					object,
					rid: burnRid,
					...(await safeCall(`/obj/${object}/term-burn?blocks=40000&rid=${burnRid}`))
				};
				const readRid = crypto.randomUUID();
				const read = {
					object,
					rid: readRid,
					...(await safeCall(`/obj/${object}/term-read?rid=${readRid}`))
				};
				return [burn, read];
			})
		)
	);
	const events = await tailEvents('d2');
	const calls = rows.flat().map((row) => attach(row, events));
	const pairs = objects.map((object) => {
		const [burn, read] = calls.filter((row) => row.object === object);
		if (!burn || !read) throw new Error(`${object}: expected a burn and a read`);
		return {
			object,
			burnStatus: burn.status,
			burnOutcome: burn.tail?.outcome ?? null,
			burnCpuMs: burn.tail?.cpuTime ?? null,
			burnIsolate: burn.tail?.isolate ?? null,
			readStatus: read.status,
			readOutcome: read.tail?.outcome ?? null,
			readIsolate: read.body?.isolate ?? null,
			isolateChanged:
				Boolean(burn.tail?.isolate) && read.body?.isolate !== burn.tail?.isolate,
			word1028: read.body?.word1028 ?? null,
			word1024: read.body?.word1024 ?? null
		};
	});
	await save('d2.json', { arm: 'd2', pairs, outcomes: events.outcomes, calls });
	console.log(JSON.stringify({ pairs, outcomes: events.outcomes }));
}

function chainSummary(
	object: string,
	body: any,
	events: Events,
	expected: { final: string; sha: string }
) {
	const job = body?.job ?? null;
	const slices = (body?.slices ?? []).map((s: any) => ({
		...s,
		tail: events.byKey.get(`${s.isolate}:${s.ordinal}`) ?? null
	}));
	const checkpointRows = slices.reduce(
		(sum: number, s: any) =>
			sum +
			(s.tail?.notes ?? [])
				.filter((n: any) => n.kind === 'checkpoint')
				.reduce((a: number, n: any) => a + n.rows, 0),
		0
	);
	return {
		object,
		finished: job?.finished === 1,
		steps: job?.steps ?? null,
		finalMatch: job?.final === expected.final,
		shaMatch: job?.sha === expected.sha,
		slices: slices.length,
		restores: slices.filter((s: any) => s.restored === 1).length,
		restoredAt: slices.filter((s: any) => s.restored === 1).map((s: any) => s.k),
		isolates: new Set(slices.map((s: any) => s.isolate)).size,
		isolateChanges: slices
			.slice(1)
			.filter((s: any, i: number) => s.isolate !== slices[i].isolate).length,
		ran: slices.map((s: any) => s.ran),
		cpuMs: slices.map((s: any) => s.tail?.cpuTime ?? null),
		outcomes: slices.map((s: any) => s.tail?.outcome ?? null),
		checkpointRows,
		pass:
			job?.finished === 1 &&
			job?.final === expected.final &&
			job?.sha === expected.sha &&
			(local || slices.every((s: any) => s.tail?.outcome === 'ok'))
	};
}

// one chain per object; `release` makes the driver abort and release each object whenever a job pauses
async function chainArm(
	name: string,
	objects: string[],
	query: string,
	expectedSteps: number,
	release: boolean
) {
	if (!local) await cloud();
	const reference = (await load('reference.json'))[String(expectedSteps)];
	const polls: Record<string, any> = {};
	const actions: any[] = [];
	const t0 = Date.now();
	const starts = await withTail(name, async () => {
		const started = await Promise.all(
			objects.map((object) => safeCall(`/obj/${object}/chain?${query}`))
		);
		while (true) {
			await sleep(5000);
			const rows = await Promise.all(
				objects.map((object) => safeCall(`/obj/${object}/status`))
			);
			for (const [i, object] of objects.entries()) {
				const body = rows[i]!.body;
				if (body?.job) polls[object] = body;
				if (release && body?.job?.paused === 1) {
					actions.push({
						object,
						action: 'abort',
						slices: body.slices.length,
						t: Date.now() - t0
					});
					await safeCall(`/obj/${object}/abort`);
					const released = await safeCall(`/obj/${object}/release`);
					actions.push({
						object,
						action: 'release',
						status: released.status,
						t: Date.now() - t0
					});
				}
			}
			const done = objects.every((object) => polls[object]?.job?.finished === 1);
			if (done || Date.now() - t0 > 25 * 60 * 1000) break;
		}
		return started;
	});
	const events = await tailEvents(name);
	const chains = objects.map((object) => chainSummary(object, polls[object], events, reference));
	await save(`${name}.json`, {
		arm: name,
		query,
		actions,
		startStatus: starts.map((r) => r.status),
		chains,
		polls,
		outcomes: events.outcomes
	});
	console.log(JSON.stringify({ actions: actions.length, chains, outcomes: events.outcomes }));
}

async function d0() {
	base = 'http://127.0.0.1:8788';
	local = true;
	const object = `d0-${uuid8()}`;
	await chainArm(
		'd0',
		[object],
		`steps=${LOCAL_STEPS}&every=100&drop=7,15,22`,
		LOCAL_STEPS,
		false
	);
}

async function d3() {
	const objects = [0, 1, 2].map((i) => `d3-${uuid8()}-${i}`);
	await chainArm('d3', objects, `steps=${CHAIN_STEPS}`, CHAIN_STEPS, false);
}

async function d4() {
	const object = `d4-${uuid8()}`;
	await chainArm('d4', [object], `steps=${CHAIN_STEPS}&hold=1,3`, CHAIN_STEPS, true);
}

// D5: per object base (dirty 0, one checkpoint), ck (five dirty+checkpoint), control (five dirty only)
async function d5() {
	await cloud();
	const objects = [0, 4, 16].flatMap((dirty) =>
		[0, 1].map((i) => ({ object: `d5-${uuid8()}-${dirty}-${i}`, dirty }))
	);
	const rows = await withTail('d5', () =>
		Promise.all(
			objects.map(async ({ object, dirty }) => {
				const out: any[] = [];
				for (const mode of ['base', 'ck', 'control']) {
					const rid = crypto.randomUUID();
					const d = mode === 'base' ? 0 : dirty;
					out.push({
						object,
						dirty,
						mode,
						rid,
						...(await safeCall(`/obj/${object}/ck?mode=${mode}&dirty=${d}&rid=${rid}`))
					});
				}
				return out;
			})
		)
	);
	const events = await tailEvents('d5');
	const calls = rows.flat().map((row) => attach(row, events));
	const perObject = objects.map(({ object, dirty }) => {
		const mine = calls.filter((row) => row.object === object);
		const by = (mode: string) => mine.find((row) => row.mode === mode);
		const cpu = (row: any) => row?.tail?.cpuTime ?? null;
		const base = by('base');
		const ck = by('ck');
		const control = by('control');
		const rowsOf = (row: any) =>
			(row?.body?.results ?? []).reduce((a: number, r: any) => a + r.rows, 0);
		const C_k = cpu(ck) !== null && cpu(control) !== null ? (cpu(ck) - cpu(control)) / 5 : null;
		return {
			object,
			dirty,
			outcomes: mine.map((row) => row.tail?.outcome ?? null),
			baseCpuMs: cpu(base),
			ckCpuMs: cpu(ck),
			controlCpuMs: cpu(control),
			C_k,
			rows: rowsOf(base) + rowsOf(ck),
			restoredCk: ck?.body?.restored ?? null,
			checkpointsCk: ck?.body?.results?.length ?? null
		};
	});
	const cells = [0, 4, 16].map((dirty) => {
		const mine = perObject.filter((o) => o.dirty === dirty);
		return {
			dirtyMiB: dirty,
			n: mine.length,
			C_kMs: mine.map((o) => o.C_k),
			medianC_kMs: median(mine.map((o) => o.C_k!).filter((v) => v !== null)),
			rows: mine.reduce((a, o) => a + o.rows, 0),
			outcomes: mine.flatMap((o) => o.outcomes)
		};
	});
	await save('d5.json', { arm: 'd5', perObject, cells, outcomes: events.outcomes, calls });
	console.log(JSON.stringify({ cells, outcomes: events.outcomes }));
}

const arms: Record<string, () => Promise<void>> = {
	d0,
	d1,
	d2,
	d3,
	d4,
	d5,
	'snap-before': () => snap('snapshot-before.json'),
	'snap-after': () => snap('snapshot-after.json')
};

const run = arms[arm];
if (!run) throw new Error(`unknown arm: ${arm}`);
await run();
