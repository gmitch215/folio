import { appendFileSync, mkdirSync } from 'node:fs';

// one fresh object per sample; one first event, then a read-back from a fresh stub 3 s later
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker');
const arms = (
	process.env.ARMS ??
	'start-near-awaited,start-near-unawaited,start-near-awaited-end-sync,start-5s-awaited,end-sync-then-near,end-near-awaited-then-sync,no-alarm,alarm-1ms,alarm-10ms,alarm-100ms,alarm-1s,alarm-5s,alarm-60s'
).split(',');
const samples = Number(process.env.SAMPLES ?? 20);
const gapMs = Number(process.env.GAP ?? 1500);
const maxRequests = Number(process.env.MAX_REQUESTS ?? 7000);
const outDir = process.env.OUT;
if (!outDir) throw new Error('set OUT');
const run = Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const out = `${outDir}/first-event.jsonl`;
mkdirSync(outDir, { recursive: true });

type Reply = {
	event?: {
		ok: boolean;
		error?: string;
		body?: { inst: string; iso: string; existingMs: number | null };
	};
	readback?: {
		ok: boolean;
		error?: string;
		body?: {
			inst: string;
			marker: boolean;
			effect: boolean;
			markerRows: number;
			effectRows: number;
			alarmAt: number | null;
		};
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

const stateOf = (marker: boolean, effect: boolean) => {
	if (marker && effect) return 'both';
	if (!marker && !effect) return 'neither';
	return marker ? 'M-only' : 'E-only';
};

let requests = 0;
let events = 0;
outer: for (let k = 0; k < samples; k++) {
	for (const arm of arms) {
		if (requests >= maxRequests) break outer;
		const object = `first-${run}-${arm}-${k}`;
		const t0 = performance.now();
		let reply: Reply | null = null;
		let clientError: string | null = null;
		requests++;
		try {
			const res = await fetch(`${base}/?do=${object}&arm=${arm}&mode=first`);
			reply = (await res.json()) as Reply;
		} catch (e) {
			clientError = String(e).slice(0, 300);
		}
		const wallMs = Math.round(performance.now() - t0);
		const ev = reply?.event ?? null;
		const rb = reply?.readback ?? null;
		const eventOk = ev?.ok === true;
		const eventError = clientError ?? (eventOk ? null : (ev?.error ?? 'no event reply'));
		const eventCls = eventOk ? 'ok' : clientError ? 'client' : classOf(eventError ?? '');
		const readOk = rb?.ok === true && rb.body !== undefined;
		const marker = readOk ? rb!.body!.marker : false;
		const effect = readOk ? rb!.body!.effect : false;
		const eventInst = eventOk ? (ev?.body?.inst ?? null) : null;
		const readInst = readOk ? (rb!.body!.inst ?? null) : null;
		const rec = {
			arm,
			k,
			object,
			wallMs,
			eventOk,
			eventCls,
			eventError,
			eventInst,
			eventIso: eventOk ? (ev?.body?.iso ?? null) : null,
			readOk,
			readError: readOk ? null : (rb?.error ?? 'no readback'),
			readInst,
			instChanged: eventInst !== null && readInst !== null ? eventInst !== readInst : null,
			markerRows: readOk ? rb!.body!.markerRows : null,
			effectRows: readOk ? rb!.body!.effectRows : null,
			readAlarmAheadMs:
				readOk && rb!.body!.alarmAt != null ? rb!.body!.alarmAt - Date.now() : null,
			state: readOk ? stateOf(marker, effect) : 'unread'
		};
		events++;
		appendFileSync(out, `${JSON.stringify(rec)}\n`);
		console.log(`${arm} k=${k} event=${rec.eventCls} state=${rec.state} wallMs=${wallMs}`);
		await sleep(gapMs);
	}
}
console.log(`events=${events} entryRequests=${requests}`);
console.log(out);
