import { appendFile, mkdir } from 'node:fs/promises';
import { Abort, Counters, type Expect } from '../elastic-limits/counters.ts';
import { scrub } from '../elastic-limits/redact.ts';
import { quotaExhausted } from '../lib/quota.ts';
import type { Cell, LadderConfig, LadderPrice } from './plan.ts';
import { priceCell, rowsPerPage } from './plan.ts';
import { PAGE } from './programs.ts';
import type { RunConfig } from './service.ts';

export interface LadderCtx {
	base: string;
	secret: string;
	fetchImpl: typeof fetch;
	counters: Counters;
	sink: (record: object) => Promise<void>;
	timeoutMs: number;
	heartbeatMs: number;
	// rows read are not in the shared counters; the price predicts them too
	readRows: { value: number };
}

// kept whole for an HTML error page, so a Cloudflare error code survives into the raw line
const ERROR_BODY_CHARS = 8192;

export async function makeLadderCtx(o: {
	config: LadderConfig;
	planned: LadderPrice;
	base: string;
	secret: string;
	fetchImpl?: typeof fetch;
	rawFile: URL;
	log?: (line: object) => void;
	timeoutMs?: number;
	heartbeatMs?: number;
}): Promise<LadderCtx> {
	await mkdir(new URL('./', o.rawFile), { recursive: true });
	const log = o.log ?? ((line) => console.log(JSON.stringify(scrub(line))));
	return {
		base: o.base,
		secret: o.secret,
		fetchImpl: o.fetchImpl ?? fetch,
		counters: new Counters(o.planned, o.config.caps, log),
		sink: (record) => appendFile(o.rawFile, JSON.stringify(scrub(record)) + '\n'),
		timeoutMs: o.timeoutMs ?? 150000,
		heartbeatMs: o.heartbeatMs ?? 1000,
		readRows: { value: 0 }
	};
}

// one line per interval while a run request is in flight; a gap between lines is a stall in this client
function heartbeat(ctx: LadderCtx, cell: Cell, segment: number) {
	let last = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		// a lost heartbeat line must not end the run
		ctx.sink({
			level: 'heartbeat',
			ts: new Date().toISOString(),
			monoMs: now,
			sinceLastMs: now - last,
			variant: cell.variant.name,
			workload: cell.workload,
			repeat: cell.repeat,
			op: 'run',
			segment
		}).catch(() => {});
		last = now;
	}, ctx.heartbeatMs);
	return () => clearInterval(timer);
}

export interface Reply {
	status: number;
	wallMs: number;
	colo: string | null;
	body: any;
	checkpoint?: Uint8Array;
	epoch?: string;
	completion?: string;
}

const minuteOf = (iso: string) => iso.slice(0, 16) + ':00Z';

async function call(
	ctx: LadderCtx,
	cell: Cell,
	name: string,
	op: 'init' | 'run' | 'verify' | 'clear',
	cfg: RunConfig,
	expect: Expect,
	segment = 0,
	resume?: { checkpoint: Uint8Array; epoch: string; completion: string }
): Promise<Reply> {
	ctx.counters.guard(expect);
	ctx.counters.issue(expect);
	const ts = new Date().toISOString();
	const at = performance.now();
	const wallAt = Date.now();
	const stopBeat = op === 'run' ? heartbeat(ctx, cell, segment) : () => {};
	let status = 0;
	let colo: string | null = null;
	let body: any = null;
	let text = '';
	let error: string | undefined;
	let checkpoint: Uint8Array | undefined;
	let epoch: string | undefined;
	let completion: string | undefined;
	try {
		const headers: Record<string, string> = { authorization: `Bearer ${ctx.secret}` };
		if (resume) {
			headers['x-epoch'] = resume.epoch;
			headers['x-completion'] = resume.completion;
		}
		const response = await ctx.fetchImpl(
			`${ctx.base}/obj/${name}/${op}?cfg=${encodeURIComponent(JSON.stringify(cfg))}`,
			{
				method: 'POST',
				body: resume?.checkpoint as BodyInit | undefined,
				headers,
				signal: AbortSignal.timeout(ctx.timeoutMs)
			}
		);
		status = response.status;
		colo = response.headers.get('x-front-colo') || null;
		if (status === 200 && response.headers.get('x-done') === '0') {
			checkpoint = new Uint8Array(await response.arrayBuffer());
			epoch = response.headers.get('x-epoch') ?? undefined;
			completion = response.headers.get('x-completion') ?? undefined;
			body = JSON.parse(response.headers.get('x-meta') ?? '{}');
		} else {
			text = await response.text();
			try {
				body = JSON.parse(text);
			} catch {
				// a platform error page is not JSON
			}
		}
	} catch (e) {
		error = String(e);
	}
	stopBeat();
	const wallMs = performance.now() - at;
	const wallClockMs = Date.now() - wallAt;
	const ok = status === 200 && body !== null;
	// the effect of a failed call is unknown, so it counts as the worst case
	const rows = ok ? 0 : (expect.rows ?? 0);
	if (!ok) ctx.counters.record(0, { requests: 1 });
	else
		ctx.counters.record(0, {
			requests: 1,
			schemaRows: op === 'init' ? body.setupRows : 0,
			writeRows: op === 'init' ? body.rows : op === 'run' ? body.rowsWritten : 0,
			cleanupRows: op === 'clear' ? body.rows : 0
		});
	if (!ok && op !== 'clear') ctx.counters.record(0, { writeRows: rows });
	if (!ok && op === 'clear') ctx.counters.record(0, { cleanupRows: rows });
	if (ok) ctx.readRows.value += body.rowsRead ?? 0;
	const { stats, ...summary } = body ?? {};
	await ctx.sink({
		level: 'client',
		ts,
		startMinute: minuteOf(ts),
		variant: cell.variant.name,
		workload: cell.workload,
		pages: cell.pages,
		repeat: cell.repeat,
		op,
		segment,
		status,
		wallMs,
		wallClockMs,
		colo,
		...summary,
		stats,
		error: error ?? (status === 200 ? summary.error : text.slice(0, ERROR_BODY_CHARS))
	});
	if (quotaExhausted(text)) throw new Abort('free quota exhausted');
	return { status, wallMs, colo, body, checkpoint, epoch, completion };
}

export const configOf = (cell: Cell): RunConfig => ({
	workload: cell.workload,
	pages: cell.pages,
	frames: cell.variant.frames,
	cold: cell.variant.cold,
	rowBytes: cell.variant.rowBytes,
	quantum: Number.isFinite(cell.variant.quantum) ? cell.variant.quantum : null,
	resident: cell.variant.resident === true
});

export interface CellResult {
	exact: boolean;
	failure?: string;
	requests: number;
	stats?: object;
	// pages left in the compressed pool when the run ended
	pooled?: number;
}

// init, run through every continuation, verify every byte, then clear; clear is tried even after a failure
export async function runCell(
	ctx: LadderCtx,
	cell: Cell,
	config: LadderConfig,
	overrides: Partial<RunConfig> = {}
): Promise<CellResult> {
	const price = priceCell(cell, config);
	const rpp = rowsPerPage(cell.variant);
	const initRows = cell.workload === 'dense' ? 0 : cell.pages * rpp;
	const cfg = { ...configOf(cell), ...overrides };
	const name = `${cell.variant.name}-${cell.workload}-${cell.repeat}-${crypto.randomUUID().slice(0, 8)}`;
	const before = ctx.counters.seen.requests;
	let failure: string | undefined;
	let stats: object | undefined;
	let pooled: number | undefined;
	let exact = false;
	let initOk = false;
	try {
		const init = await call(ctx, cell, name, 'init', cfg, {
			rows: initRows + price.schemaRows
		});
		if (init.status !== 200) throw new Error(`init ${init.status}`);
		initOk = true;
		let resume: { checkpoint: Uint8Array; epoch: string; completion: string } | undefined;
		const runRows = price.writeRows - initRows;
		for (let segment = 0; ; segment++) {
			const r = await call(ctx, cell, name, 'run', cfg, { rows: runRows }, segment, resume);
			if (r.status !== 200) throw new Error(`run ${r.status} ${r.body?.error ?? ''}`);
			if (r.body.done) {
				stats = r.body.stats;
				pooled = r.body.pooled;
				exact = r.body.exact === true;
				if (!exact) failure = `checksum ${r.body.result} expected ${r.body.expected}`;
				break;
			}
			if (r.checkpoint?.length !== PAGE) throw new Error('bad checkpoint');
			resume = { checkpoint: r.checkpoint, epoch: r.epoch!, completion: r.completion! };
		}
		if (exact) {
			const verify = await call(ctx, cell, name, 'verify', cfg, {});
			if (verify.status !== 200 || verify.body.exact !== true) {
				exact = false;
				failure = `verify ${verify.status} ${verify.body?.mismatches ?? ''} mismatched pages`;
			}
		}
	} catch (error) {
		if (error instanceof Abort) throw error;
		failure = String(error);
		exact = false;
	} finally {
		// a failed init wrote at most its schema rows and, for a non-dense workload, the pages
		await call(ctx, cell, name, 'clear', cfg, {
			rows: initOk ? price.cleanupRows : initRows
		}).catch(() => {});
	}
	ctx.counters.progress(`${cell.variant.name} ${cell.workload} ${cell.repeat}`);
	return { exact, failure, requests: ctx.counters.seen.requests - before, stats, pooled };
}
