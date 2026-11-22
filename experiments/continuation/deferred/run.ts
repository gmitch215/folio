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
const config = 'experiments/continuation/deferred/wrangler.jsonc';
const worker = 'folio-continuation-deferred';
const CHAIN_STEPS = 120000;
const LOCAL_STEPS = 3000;
const WARM_STEPS = 1000;
const STALL_MS = 150000;
const WALL_CAP_MS = 25 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uuid8 = () => crypto.randomUUID().slice(0, 8);
const save = async (file: string, value: unknown) => {
	await mkdir(runs, { recursive: true });
	await writeFile(new URL(file, runs), `${JSON.stringify(value, null, 2)}\n`);
};
const load = async (file: string) => JSON.parse(await readFile(new URL(file, runs), 'utf8'));

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

// the wrangler tail is the only CPU record for deployed arms; the local arm has none
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
	const all: TailRow[] = [];
	const outcomes: Record<string, number> = {};
	if (local) {
		// the local arm has no tail; its notes come from the wrangler dev log
		const text = await readFile(new URL(`${name}-dev.log`, runs), 'utf8').catch(() => '');
		for (const line of text.split('\n')) {
			if (!line.includes('"tag":"ev"')) continue;
			const note = parseOrNull(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
			if (!note) continue;
			const key = `${note.isolate}:${note.ordinal}`;
			const row: TailRow = byKey.get(key) ?? {
				outcome: 'ok',
				cpuTime: 0,
				isolate: note.isolate,
				notes: []
			};
			if (!byKey.has(key)) all.push(row);
			row.notes.push(note);
			byKey.set(key, row);
		}
		return { byKey, all, outcomes };
	}
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
			}
		}
		all.push(row);
	}
	return { byKey, all, outcomes };
}

type Events = Awaited<ReturnType<typeof tailEvents>>;
type Log = (action: string, extra?: Record<string, unknown>) => void;

// one object's chain: slices from the storage rows, joined to the tail by isolate and ordinal
function summarize(body: any, events: Events, reference: { final: string; sha: string }) {
	const slices = (body.slices ?? []).map((s: any) => {
		const tail = events.byKey.get(`${s.isolate}:${s.ordinal}`) ?? null;
		const notes = tail?.notes ?? [];
		const signal = notes.find((n: any) => n.kind === 'signal') ?? null;
		const checkpoints = notes.filter((n: any) => n.kind === 'checkpoint');
		return {
			k: s.k,
			isolate: s.isolate,
			restored: s.restored,
			lost: s.lost,
			unsavedSeen: s.unsaved_seen,
			stepsStart: s.steps_start,
			sigStepsDb: s.sig_steps,
			sigStepsTail: signal?.steps ?? null,
			ranAtSignal: signal?.ran ?? null,
			midsAtSignal: signal?.mids ?? null,
			stepsEnd: s.steps_end,
			ranFinal: notes.find((n: any) => n.kind === 'final')?.ran ?? null,
			outcome: tail?.outcome ?? null,
			cpuMs: tail?.cpuTime ?? null,
			checkpointWhy: checkpoints.map((n: any) => n.why),
			checkpointRows: checkpoints.reduce((a: number, n: any) => a + n.rows, 0),
			bookkeepingRows: notes.reduce((a: number, n: any) => a + (n.book ?? 0), 0)
		};
	});
	const restoredAt = slices.filter((s: any) => s.restored === 1).map((s: any) => s.k);
	const job = body.job;
	// steps lost, against the slice that was lost: its own steps at signal minus its start
	const lossChecks = slices
		.filter((s: any) => s.restored === 1)
		.map((s: any) => {
			const prev = slices.find((p: any) => p.k === s.k - 1);
			const prevSteps =
				prev && prev.sigStepsTail !== null ? prev.sigStepsTail - prev.stepsStart : null;
			return {
				k: s.k,
				lost: s.lost,
				prevSliceSteps: prevSteps,
				below: prevSteps === null ? null : s.lost < prevSteps
			};
		});
	const moves = slices
		.slice(1)
		.filter((s: any, i: number) => s.isolate !== slices[i].isolate).length;
	return {
		finished: job?.finished === 1,
		steps: job?.steps ?? null,
		finalMatch: job?.final === reference.final,
		shaMatch: job?.sha === reference.sha,
		slices,
		restores: restoredAt.length,
		restoredAt,
		lossChecks,
		isolateMoves: moves,
		isolates: [...new Set(slices.map((s: any) => s.isolate))],
		sigSteps: slices.map((s: any) => s.sigStepsTail).filter((v: any) => v !== null),
		// a slice that ended on the signal, then a restore: did its unsaved flag survive the isolate change?
		signalWrites: slices
			.slice(0, -1)
			.map((s: any, i: number) => ({
				k: s.k,
				endedOnSignal: s.sigStepsTail !== null,
				next: slices[i + 1]
			}))
			.filter((p: any) => p.endedOnSignal && p.next.restored === 1)
			.map((p: any) => ({ k: p.k, landed: p.next.unsavedSeen === 1 })),
		rows: slices.reduce((a: number, s: any) => a + s.checkpointRows + s.bookkeepingRows, 0)
	};
}

// stop a deployed arm when its tail passes the CPU or row cap (the Worker is deleted after the arm)
async function overCap(name: string, cap: { cpuMs: number; rows: number }) {
	const events = await tailEvents(name);
	let cpuMs = 0;
	let rows = 0;
	for (const row of events.all) {
		cpuMs += row.cpuTime ?? 0;
		for (const note of row.notes) rows += (note.rows ?? 0) + (note.book ?? 0);
	}
	return { cpuMs, rows, over: cpuMs > cap.cpuMs || rows > cap.rows };
}

// one object's events in slice order. A restart (isolate move or manifest restore) loses the
// previous event's end steps minus the steps the restart began from; that is the true loss.
function bcTrace(chain: { isolates: unknown[] }, events: Events) {
	const mine = new Set(chain.isolates);
	const groups = new Map<string, any[]>();
	for (const row of events.all) {
		if (!mine.has(row.isolate ?? '')) continue;
		for (const note of row.notes) {
			const key = `${note.isolate}:${note.ordinal}`;
			groups.set(key, [...(groups.get(key) ?? []), note]);
		}
	}
	const rows = [...groups.values()]
		.map((notes) => {
			const slice = notes.find((n) => n.kind === 'slice');
			const end = notes.find(
				(n) => n.kind === 'final' || n.kind === 'commit' || n.kind === 'signal'
			);
			// a completed commit or final checkpoint marks the same end when its commit note is missing from the tail
			const committed = notes
				.filter((n) => n.kind === 'checkpoint' && (n.why === 'commit' || n.why === 'final'))
				.at(-1);
			const cut = notes.some((n) => n.kind === 'cut');
			const stopNote = end ?? committed ?? null;
			const stopKind =
				stopNote?.kind === 'checkpoint'
					? stopNote.why === 'final'
						? 'final'
						: 'commit'
					: stopNote?.kind;
			return {
				k: slice?.k ?? null,
				isolate: notes[0].isolate as string,
				restored: slice?.restored ?? null,
				start: slice?.steps ?? null,
				budget: slice?.b ?? null,
				stop: stopNote ? (cut ? 'cut' : stopKind) : 'none',
				endSource: end ? 'end-note' : committed ? 'checkpoint-note' : 'none',
				end: stopNote?.steps ?? null,
				budgetAfter: end?.b ?? null,
				rows: notes.reduce((a: number, n: any) => a + (n.rows ?? 0) + (n.book ?? 0), 0)
			};
		})
		.filter((r) => r.k !== null)
		.sort((a, b) => a.k - b.k);
	const restarts = rows.slice(1).flatMap((cur, i) => {
		const prev = rows[i]!;
		const moved = cur.isolate !== prev.isolate;
		if (!moved && cur.restored !== 1) return [];
		return [
			{
				k: cur.k,
				moved,
				restored: cur.restored,
				prevStop: prev.stop,
				trueLoss: prev.end === null || cur.start === null ? null : prev.end - cur.start,
				afterCommit: prev.stop === 'commit'
			}
		];
	});
	return {
		events: rows,
		restarts,
		cuts: rows.filter((r) => r.stop === 'cut').length,
		signalFirst: rows.filter((r) => r.stop === 'signal' || r.stop === 'cut').length,
		rows: rows.reduce((a, r) => a + r.rows, 0)
	};
}

// drives one or more chains. `act` runs on each poll and may call routes; it logs every action it takes.
async function drive(
	name: string,
	objects: string[],
	query: string,
	expected: number,
	act?: (object: string, body: any, log: Log) => Promise<void>,
	warm = true,
	caps?: { cpuMs: number; rows: number }
) {
	let capped: { cpuMs: number; rows: number } | null = null;
	if (!local) await cloud();
	const reference = (await load('reference.json'))[String(expected)];
	const polls: Record<string, any> = {};
	const actions: any[] = [];
	const progress: Record<string, { n: number; at: number }> = {};
	const t0 = Date.now();
	const log: Log = (action, extra = {}) => actions.push({ action, t: Date.now() - t0, ...extra });
	const starts = await withTail(name, async () => {
		if (!local && warm) {
			for (const object of objects) await safeCall(`/obj/${object}/init`);
			for (const object of objects) {
				const r = await safeCall(`/obj/${object}/warm?steps=${WARM_STEPS}`);
				log('warm', { object, status: r.status });
			}
			await sleep(8000);
		}
		const started = await Promise.all(
			objects.map((object) => safeCall(`/obj/${object}/chain?${query}`))
		);
		while (true) {
			await sleep(3000);
			const rows = await Promise.all(
				objects.map((object) => safeCall(`/obj/${object}/status`))
			);
			for (const [i, object] of objects.entries()) {
				const body = rows[i]!.body;
				if (!body?.job) continue;
				polls[object] = body;
				await act?.(object, body, (action, extra) => log(action, { object, ...extra }));
				if (body.job.finished === 1) continue;
				const n = body.slices.length;
				const p = progress[object];
				if (!p || p.n !== n) progress[object] = { n, at: Date.now() };
				else if (Date.now() - p.at > STALL_MS) {
					const r = await safeCall(`/obj/${object}/release`);
					log('release', { object, status: r.status, slices: n });
					progress[object] = { n, at: Date.now() };
				}
			}
			if (caps && !local) {
				const usage = await overCap(name, caps);
				if (usage.over) {
					capped = usage;
					log('cap', usage);
					break;
				}
			}
			if (
				objects.every((o) => polls[o]?.job?.finished === 1) ||
				Date.now() - t0 > WALL_CAP_MS
			)
				break;
		}
		return started;
	});
	const events = await tailEvents(name);
	const chains = Object.fromEntries(
		objects.map((object) => [object, summarize(polls[object] ?? {}, events, reference)])
	);
	const doEvents = events.all.filter((row) => row.notes.length > 0);
	const exceeded = doEvents.filter((row) => row.outcome === 'exceededCpu').length;
	const summary = {
		arm: name,
		query,
		startStatus: starts.map((r) => r.status),
		actions,
		chains,
		doEvents: doEvents.length,
		cpuMsDO: doEvents.reduce((a, row) => a + (row.cpuTime ?? 0), 0),
		outcomesDO: doEvents.reduce<Record<string, number>>(
			(a, row) => ({ ...a, [row.outcome]: (a[row.outcome] ?? 0) + 1 }),
			{}
		),
		exceededCpu: exceeded,
		rows: Object.values(chains).reduce((a, c) => a + c.rows, 0),
		capped,
		pass:
			objects.every(
				(o) => chains[o]!.finished && chains[o]!.finalMatch && chains[o]!.shaMatch
			) && exceeded === 0
	};
	await save(`${name}.json`, summary);
	console.log(JSON.stringify(summary, null, 2));
	return summary;
}

async function f0() {
	base = 'http://127.0.0.1:8788';
	local = true;
	const object = `f0-${uuid8()}`;
	await drive('f0', [object], 'steps=3000&every=100&sim=1&drop=7,15,22', LOCAL_STEPS);
}

async function f1() {
	const objects = [0, 1, 2].map((i) => `f1-${uuid8()}-${i}`);
	await drive('f1', objects, `steps=${CHAIN_STEPS}&every=0&mid=0&sim=0`, CHAIN_STEPS);
}

// forced losses: abort when slice 2 (then slice 4) ends with the signal writes pending
async function f2() {
	const object = `f2-${uuid8()}`;
	const aborted: number[] = [];
	await drive(
		'f2',
		[object],
		`steps=${CHAIN_STEPS}&every=0&mid=0&sim=0`,
		CHAIN_STEPS,
		async (o, body, log) => {
			const want = [2, 4][aborted.length];
			if (want === undefined || body.job.unsaved !== 1 || body.slices.length !== want) return;
			aborted.push(want);
			const r = await safeCall(`/obj/${o}/abort?rid=${crypto.randomUUID()}`);
			log('abort', { slices: want, status: r.status });
		}
	);
}

// mid-event checkpoints: slice 1 measures steps at signal; the budget is 40% of that for the rest
async function f3() {
	const object = `f3-${uuid8()}`;
	let budgetSet = false;
	await drive(
		'f3',
		[object],
		`steps=${CHAIN_STEPS}&every=0&mid=0&sim=0`,
		CHAIN_STEPS,
		async (o, body, log) => {
			if (budgetSet) return;
			const first = body.slices[0];
			if (first?.sig_steps == null) return;
			budgetSet = true;
			const every = Math.round(0.4 * first.sig_steps);
			const r = await safeCall(`/obj/${o}/budget?every=${every}&mid=1`);
			log('budget', { every, signalSteps: first.sig_steps, status: r.status });
		}
	);
}

// placement: no warm-up; 500-step checkpointed segments until the isolate moves or 4,000 steps run
async function f4() {
	const objects = [0, 1, 2].map((i) => `f4-${uuid8()}-${i}`);
	const s = await drive(
		'f4',
		objects,
		`steps=${CHAIN_STEPS}&every=0&mid=0&sim=0&place=1`,
		CHAIN_STEPS,
		undefined,
		false
	);
	const moves = Object.entries(s.chains).flatMap(([object, c]: [string, any]) =>
		c.slices.flatMap((slice: any, i: number) =>
			i > 0 && slice.isolate !== c.slices[i - 1].isolate
				? [{ object, k: slice.k, restored: slice.restored, lost: slice.lost }]
				: []
		)
	);
	const pass =
		s.pass &&
		objects.every((o) => moves.some((m) => m.object === o)) &&
		moves.every((m) => m.lost <= 500);
	await save('f4-moves.json', { moves, pass });
	console.log(JSON.stringify({ moves, pass }));
}

// boundary-commit local arm: simulated signal at 5,000 steps per event, a cut in the commit of event 6, drops before events 4 and 9
async function g0() {
	base = 'http://127.0.0.1:8788';
	local = true;
	const object = `g0-${uuid8()}`;
	const s = await drive(
		'g0',
		[object],
		'steps=30000&mode=bc&b0=1000&sim_at=5000&cut_at=6&drop=4,9',
		30000,
		undefined,
		false
	);
	const trace = bcTrace(s.chains[object]!, await tailEvents('g0'));
	await save('g0-bc.json', trace);
	console.log(JSON.stringify(trace));
}

// re-trace the saved boundary-commit deployed tail with the checkpoint fallback in bcTrace; the driver's own pass is left as recorded
async function g1Retrace() {
	const saved = await load('g1.json');
	const events = await tailEvents('g1');
	const traces = Object.fromEntries(
		Object.entries(saved.chains).map(([object, chain]: [string, any]) => [
			object,
			bcTrace(chain, events)
		])
	);
	const pass = Object.values(traces).every(
		(t: any) =>
			t.restarts.filter((r: any) => r.afterCommit).every((r: any) => r.trueLoss === 0) &&
			t.restarts.some((r: any) => r.moved && r.afterCommit)
	);
	await save('g1-bc-retrace.json', { pass, traces });
	console.log(JSON.stringify({ pass, traces }));
}

// boundary-commit deployed arm: 3 fresh objects, no warm-up, budget from 2,000 steps; the CPU and row caps stop the arm
async function g1() {
	const objects = [0, 1, 2].map((i) => `g1-${uuid8()}-${i}`);
	const s = await drive(
		'g1',
		objects,
		`steps=${CHAIN_STEPS}&mode=bc&b0=2000`,
		CHAIN_STEPS,
		undefined,
		false,
		{
			cpuMs: 9 * 60 * 1000,
			rows: 3500
		}
	);
	const events = await tailEvents('g1');
	const traces = Object.fromEntries(objects.map((o) => [o, bcTrace(s.chains[o]!, events)]));
	const pass = objects.every(
		(o) =>
			s.chains[o]!.finished &&
			s.chains[o]!.finalMatch &&
			s.chains[o]!.shaMatch &&
			traces[o]!.restarts.filter((r) => r.afterCommit).every((r) => r.trueLoss === 0) &&
			traces[o]!.restarts.some((r) => r.moved && r.afterCommit)
	);
	await save('g1-bc.json', { pass, traces });
	console.log(JSON.stringify({ pass, traces }));
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
			probeScriptPresent: shot.scripts.includes(worker)
		})
	);
}

const arms: Record<string, () => Promise<void>> = {
	f0,
	f1,
	f2,
	f3,
	f4,
	g0,
	g1,
	'g1-retrace': g1Retrace,
	'snap-before': () => snap('snapshot-before.json'),
	'snap-after': () => snap('snapshot-after.json')
};

const run = arms[arm];
if (!run) throw new Error(`unknown arm: ${arm}`);
await run();
