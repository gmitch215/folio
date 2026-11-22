import { appendFileSync, mkdirSync } from 'node:fs';

// one object per chain; up to 24 events, each event a fresh stub of the same object name
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const arms = (
	process.env.ARMS ??
	'no-alarm,start-near-awaited,start-near-awaited-end-sync,start-near-awaited-no-writes,start-5s-awaited,start-near-unawaited,end-sync-then-near,end-near-awaited-then-sync,end-near-unawaited,end-far-unawaited,end-near-unawaited-no-gap'
).split(',');
const samples = Number(process.env.SAMPLES ?? 20);
const events = Number(process.env.EVENTS ?? 24);
const gapMs = Number(process.env.GAP ?? 500);
const conc = Number(process.env.CONC ?? 4);
const maxRequests = Number(process.env.MAX_REQUESTS ?? 7000);
// arms with a -no-gap suffix send their events back to back
const gapOf = (arm: string) => (arm.endsWith('-no-gap') ? 0 : gapMs);
const outDir = process.env.OUT;
if (!outDir) throw new Error('set OUT');
const run = Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const out = `${outDir}/chain.jsonl`;
mkdirSync(outDir, { recursive: true });

// nominal seconds per burn unit: the first-event burn is calibrated at about 1.5 s
const FIRST_UNITS = 230 * 1.3e6;
const SEC_PER_UNIT = 1.5 / FIRST_UNITS;
const CHAIN_CPU = Math.round(FIRST_UNITS / 6) * SEC_PER_UNIT;

type Reply = {
	event?: {
		ok: boolean;
		error?: string;
		body?: { inst: string; iso: string; alarmRuns: number; existingMs: number | null };
	};
};

const classOf = (msg: string) => {
	if (msg.includes('Internal error in Durable Object storage caused object to be reset'))
		return 'storage_reset';
	if (msg.includes('exceeded timeout')) return 'storage_timeout';
	if (/memory limit/i.test(msg)) return 'memory';
	if (/cpu time|cpu limit|exceeded cpu/i.test(msg)) return 'cpu';
	return 'other';
};

const jobs: { arm: string; k: number }[] = [];
for (let k = 0; k < samples; k++) for (const arm of arms) jobs.push({ arm, k });

let requests = 0;
let eventCount = 0;
let next = 0;

async function runChain({ arm, k }: { arm: string; k: number }) {
	const object = `chain-${run}-${arm}-${k}`;
	let prevIso: string | null = null;
	let curIso: string | null = null;
	let curCpu = 0;
	for (let ev = 1; ev <= events; ev++) {
		if (ev > 1) await sleep(gapOf(arm));
		if (requests >= maxRequests) throw new Error('request cap reached');
		requests++;
		const t0 = performance.now();
		let reply: Reply | null = null;
		let clientError: string | null = null;
		try {
			const res = await fetch(`${base}/?do=${object}&arm=${arm}&mode=chain&ev=${ev}`);
			reply = (await res.json()) as Reply;
		} catch (e) {
			clientError = String(e).slice(0, 300);
		}
		const wallMs = Math.round(performance.now() - t0);
		const e = reply?.event ?? null;
		const eventOk = e?.ok === true;
		const eventError = clientError ?? (eventOk ? null : (e?.error ?? 'no event reply'));
		const eventCls = eventOk ? 'ok' : clientError ? 'client' : classOf(eventError ?? '');
		const reset = eventCls === 'storage_reset';
		const iso = eventOk ? (e?.body?.iso ?? null) : null;
		const isoChanged = iso !== null && prevIso !== null ? iso !== prevIso : null;
		if (eventOk) {
			if (iso !== curIso) {
				curIso = iso;
				curCpu = 0;
			}
			prevIso = iso;
		}
		curCpu += CHAIN_CPU;
		const nominalCpu = Number(curCpu.toFixed(3));
		if (reset) curIso = null;
		eventCount++;
		const rec = {
			arm,
			k,
			ev,
			object,
			wallMs,
			eventOk,
			eventCls,
			eventError,
			iso,
			isoChanged,
			nominalCpu,
			reset,
			alarmRuns: eventOk ? (e?.body?.alarmRuns ?? null) : null,
			existingMs: eventOk ? (e?.body?.existingMs ?? null) : null
		};
		appendFileSync(out, `${JSON.stringify(rec)}\n`);
		console.log(
			`${arm} k=${k} ev=${ev} event=${eventCls} iso=${iso ?? '-'} changed=${isoChanged} wallMs=${wallMs}`
		);
	}
}

async function worker() {
	while (next < jobs.length) {
		const job = jobs[next++];
		if (job) await runChain(job);
	}
}

await Promise.all(Array.from({ length: conc }, worker));
console.log(`events=${eventCount} entryRequests=${requests} chains=${jobs.length}`);
console.log(out);
