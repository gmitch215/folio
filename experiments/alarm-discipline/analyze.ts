import { readFileSync } from 'node:fs';

// Joins an ab.ts run to a `wrangler tail --format json` capture of the same worker. Each platform
// failure event is credited to at most one request: the latest one that started no later than the
// event and whose window (start - 500 ms to end + 3 s) holds it. Events outside every window, such
// as the install, are counted apart.
const [abFile, tailFile] = process.argv.slice(2);
if (!abFile || !tailFile) throw new Error('usage: node analyze.ts <ab.jsonl> <tail.json>');

type Row = {
	block: number;
	arm: string;
	kind: string;
	start: number;
	end: number;
	status: number;
	err: string;
	early: string;
	isolated: string;
};
type TailEvent = {
	eventTimestamp?: number;
	outcome?: string;
	cpuTime?: number;
	exceptions?: { message?: string }[];
};

function objects(text: string): TailEvent[] {
	const events: TailEvent[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === '\\') escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === '{') {
			if (depth++ === 0) start = i;
		} else if (c === '}' && --depth === 0) {
			try {
				events.push(JSON.parse(text.slice(start, i + 1)) as TailEvent);
			} catch {
				// a truncated object at the end of a killed tail
			}
		}
	}
	return events;
}

const rows = readFileSync(abFile, 'utf8')
	.trim()
	.split('\n')
	.map((l) => JSON.parse(l) as Row);
const events = objects(readFileSync(tailFile, 'utf8'));
const classify = (e: TailEvent) => {
	const text = (e.exceptions ?? []).map((x) => x.message ?? '').join(' ');
	if (/Durable Object storage/.test(text)) return 'storage';
	if (/memory limit/.test(text)) return 'memory';
	if (/CPU time limit|exceeded/i.test(text)) return 'cpu';
	return undefined;
};

type Tally = {
	n: number;
	good: number;
	storage: number;
	memory: number;
	cpu: number;
	earlier: number;
	isolated: number;
	ms: number[];
};
const tally = (): Tally => ({
	n: 0,
	good: 0,
	storage: 0,
	memory: 0,
	cpu: 0,
	earlier: 0,
	isolated: 0,
	ms: []
});
const byArm: Record<string, Tally> = { legacy: tally(), isolated: tally() };
const byPage = new Map<string, Tally>();
const slot = (key: string) => byPage.get(key) ?? byPage.set(key, tally()).get(key)!;

for (const r of rows) {
	const good = r.status > 0 && !r.err;
	for (const t of [byArm[r.arm] ?? (byArm[r.arm] = tally()), slot(`${r.arm}:${r.kind}`)]) {
		t.n++;
		if (good) {
			t.good++;
			t.ms.push(r.end - r.start);
			t.earlier += Number(r.early || 0);
			t.isolated += Number(r.isolated || 0);
		}
	}
}

let unmatched = 0;
for (const e of events) {
	const kind = classify(e);
	if (!kind || e.eventTimestamp === undefined) continue;
	const at = e.eventTimestamp;
	const inside = rows
		.filter((r) => at >= r.start - 500 && at <= r.end + 3000 && r.start <= at)
		.sort((a, b) => b.start - a.start)[0];
	if (!inside) {
		unmatched++;
		continue;
	}
	for (const t of [byArm[inside.arm], slot(`${inside.arm}:${inside.kind}`)]) {
		if (t) t[kind]++;
	}
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
const show = (key: string, t: Tally) =>
	console.log(
		key.padEnd(16),
		`requests=${t.n}`,
		`good=${t.good}`,
		`storage=${t.storage}`,
		`memory=${t.memory}`,
		`cpu=${t.cpu}`,
		`earlier=${t.earlier}`,
		`isolated=${t.isolated}`,
		`median_ms=${median(t.ms)}`
	);
for (const [key, t] of Object.entries(byArm)) show(key, t);
for (const [key, t] of [...byPage.entries()].sort()) show(key, t);
console.log('tail events', events.length, 'failures outside every request window', unmatched);
