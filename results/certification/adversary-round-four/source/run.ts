import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { Rec, Row } from './lib.ts';

// usage: run.ts MANIFEST.jsonl SHARD COUNT SECONDS [heavy]
// manifest lines are Rec objects; rows go to results/<manifest>-<shard>.jsonl; resumable by id
const here = dirname(fileURLToPath(import.meta.url));
const [manifest, shardArg, countArg, secondsArg, mode] = process.argv.slice(2);
const shard = Number(shardArg);
const count = Number(countArg);
const seconds = Number(secondsArg ?? 100);
const heavy = mode === 'heavy';
const LIMIT = Number(process.env.LIMIT_MS ?? 115_000);

mkdirSync(join(here, 'results'), { recursive: true });
const name = manifest!.replace(/^.*\//, '').replace(/\.jsonl$/, '');
const out = join(here, 'results', `${name}-${shard}.jsonl`);
const done = new Set<string>();
if (existsSync(out))
	for (const line of readFileSync(out, 'utf8').split('\n'))
		if (line) done.add(JSON.parse(line).id);

const queue: Rec[] = readFileSync(join(here, manifest!), 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((l) => JSON.parse(l) as Rec)
	.filter((_, i) => i % count === shard)
	.filter((r) => !done.has(r.id));
const total = queue.length;
const t0 = Date.now();
const tally: Record<string, number> = {};

function spawn() {
	const w = new Worker(new URL('./eval-worker.ts', import.meta.url));
	const lane: {
		w: Worker;
		ready: Promise<void>;
		on?: (m: { row?: Row; partial?: Row; ready?: boolean }) => void;
		err?: (e: unknown) => void;
	} = { w, ready: undefined as unknown as Promise<void> };
	lane.ready = new Promise<void>((resolve) => {
		lane.on = (m) => m.ready && resolve();
	});
	w.on('message', (m) => lane.on?.(m));
	w.on('error', (e) => lane.err?.(e));
	return lane;
}

let lane = spawn();
let ran = 0;
while (queue.length && Date.now() - t0 < seconds * 1000) {
	const rec = queue.shift()!;
	await lane.ready;
	const cur = lane;
	const row = await new Promise<Row>((resolve) => {
		let over = false;
		const finish = (r: Row, fresh: boolean) => {
			if (over) return;
			over = true;
			clearTimeout(timer);
			if (fresh) {
				void cur.w.terminate();
				lane = spawn();
			}
			resolve(r);
		};
		const base = { id: rec.id, family: rec.family, sha256: '', ms: LIMIT };
		let partial: Row | undefined;
		const timer = setTimeout(
			() =>
				finish(
					partial
						? { ...partial, ms: LIMIT, reason: `no result in ${LIMIT} ms after the checker answered` }
						: ({ ...base, checker: 'RAW', kind: 'HANG-CHECKER', reason: `no certifier answer in ${LIMIT} ms` } as Row),
					true
				),
			LIMIT
		);
		cur.on = (m) => {
			if (m.partial) partial = m.partial;
			if (m.row) finish(m.row, false);
		};
		cur.err = (e) =>
			finish(
				{
					...base,
					checker: 'RAW',
					kind: 'raw-worker',
					reason: String((e as Error)?.stack ?? e).slice(0, 400)
				} as Row,
				true
			);
		cur.w.postMessage({ rec, heavy });
	});
	appendFileSync(out, JSON.stringify(row) + '\n');
	ran++;
	tally[row.kind] = (tally[row.kind] ?? 0) + 1;
	if (/FALSE|DISAGREE|raw|HANG/.test(row.kind)) console.log('FINDING', row.kind, row.id, row.reason ?? row.ground ?? row.ground2 ?? row.vreason ?? '');
}
await lane.w.terminate();
console.log(`${name} shard ${shard}/${count}: ran ${ran}, left ${total - ran}, of ${total}`, JSON.stringify(tally));
process.exit(0);
