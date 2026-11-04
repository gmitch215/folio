import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { sha256 } from '../lib.ts';
import { buildSpec, resultDir, type Row, type Spec } from './lib.ts';
import { allSpecs } from './specs.ts';

// usage: run.ts SHARD COUNT [FAMILY_REGEX] [SECONDS] [heavy]
// builds, certifies and checks every spec of the shard (rows in results/shard-SHARD.jsonl). Modules
// run on a few worker threads of this one process; a module that exceeds LIMIT_MS (60000) is killed
// and recorded. LANES (2) sets the thread count; REDO is a regex of ids to run again.
const shard = Number(process.argv[2] ?? 0);
const count = Number(process.argv[3] ?? 1);
const filter = new RegExp(process.argv[4] ?? '.');
const seconds = Number(process.argv[5] ?? 100);
const heavy = process.argv[6] === 'heavy';
const LIMIT = Number(process.env.LIMIT_MS ?? 60_000);
const LANES = Number(process.env.LANES ?? 2);

mkdirSync(resultDir, { recursive: true });
const file = join(resultDir, `shard-${shard}.jsonl`);
const done = new Set<string>();
if (existsSync(file))
	for (const line of readFileSync(file, 'utf8').split('\n'))
		if (line) done.add(JSON.parse(line).id);

const redo = process.env.REDO ? new RegExp(process.env.REDO) : undefined;
const queue = allSpecs()
	.filter((_, i) => i % count === shard)
	.filter((s) => filter.test(s.id))
	.filter((s) => !done.has(s.id) || redo?.test(s.id));
const priority = (id: string) =>
	id.startsWith('rnd-') || id.startsWith('x-')
		? 0
		: /^mu-wat-(xs|feed-ct|stride2|xlcg)\//.test(id)
			? 2
			: 1;
queue.sort((a, b) => priority(a.id) - priority(b.id));
const total = queue.length;
const t0 = Date.now();
let ran = 0;
const tally: Record<string, number> = {};

interface Lane {
	w: Worker;
	ready: Promise<void>;
	onMessage?: (m: { row?: Row; partial?: Row; ready?: boolean }) => void;
	onError?: (e: unknown) => void;
}
function spawn(): Lane {
	const w = new Worker(new URL('./eval-worker.ts', import.meta.url));
	const lane: Lane = { w, ready: undefined as unknown as Promise<void> };
	lane.ready = new Promise<void>((resolve) => {
		lane.onMessage = (m) => {
			if (m.ready) resolve();
		};
	});
	// one persistent listener pair per worker; removing listeners stops the port and loses messages
	w.on('message', (m) => lane.onMessage?.(m));
	w.on('error', (e) => lane.onError?.(e));
	return lane;
}

async function ask(
	lane: Lane,
	spec: Spec
): Promise<{ row: Row | undefined; partial: Row | undefined; lane: Lane }> {
	await lane.ready;
	return new Promise((resolve) => {
		let partial: Row | undefined;
		let over = false;
		const finish = (row: Row | undefined, next: Lane) => {
			if (over) return;
			over = true;
			clearTimeout(timer);
			resolve({ row, partial, lane: next });
		};
		const timer = setTimeout(() => {
			void lane.w.terminate();
			finish(undefined, spawn());
		}, LIMIT);
		lane.onMessage = (m) => {
			if (m.partial) partial = m.partial;
			if (m.row) finish(m.row, lane);
		};
		lane.onError = (e) => {
			void lane.w.terminate();
			finish(
				{
					id: spec.id,
					family: spec.family,
					sha256: partial?.sha256 ?? '',
					verdict: 'harness-error',
					reason: `worker error ${String(e).slice(0, 150)}`
				},
				spawn()
			);
		};
		lane.w.postMessage({ spec, heavy });
	});
}

async function runLane() {
	let lane = spawn();
	while (queue.length && Date.now() - t0 < seconds * 1000) {
		const spec = queue.shift()!;
		const r = await ask(lane, spec);
		lane = r.lane;
		let row = r.row ?? r.partial;
		if (!row) {
			let digest = '';
			try {
				digest = sha256(buildSpec(spec));
			} catch {
				// no module to hash
			}
			row = {
				id: spec.id,
				family: spec.family,
				sha256: digest,
				opt: spec.opt,
				verdict: 'harness-error',
				reason: `timeout after ${LIMIT / 1000}s before the certifier returned`,
				note: spec.note
			};
		}
		appendFileSync(file, JSON.stringify(row) + '\n');
		ran++;
		tally[row.verdict] = (tally[row.verdict] ?? 0) + 1;
		if (row.verdict === 'ACCEPTED-WRONG') console.log('WRONG', row.id, row.ground, row.ground2);
	}
	await lane.ready;
	await lane.w.terminate();
}
await Promise.all(Array.from({ length: LANES }, runLane));
console.log(
	`shard ${shard}/${count}: ran ${ran}, left ${total - ran}, of ${total}`,
	JSON.stringify(tally)
);
process.exit(tally['ACCEPTED-WRONG'] ? 1 : 0);
