import { quotaExhausted } from '../../../../experiments/lib/quota.ts';
import type { Config, Rung, RowArm } from './config.ts';
import { KIB, MIB, PAGE } from './config.ts';
import type { Expect, Seen } from './counters.ts';
import { Abort, Counters } from './counters.ts';
import { layouts, memCells, modes, rowsOfBytes, spillRows } from './plan.ts';
import { redact } from './redact.ts';

export interface Ctx {
	config: Config;
	run: string;
	base: string;
	secret: string;
	fetchImpl: typeof fetch;
	counters: Counters;
	sink: (record: object) => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	alignMinute: boolean;
	timeoutMs: number;
}

export interface Meta {
	rung: Rung | 0;
	shape: string;
	size: number;
	repeat: number;
	extra?: Record<string, unknown>;
}

export interface Reply {
	status: number;
	wallMs: number;
	colo: string | null;
	body: any;
}

const MAX_RETRIES = 2;
// a fetch that fails before any response is tried again a minute later, five times
const FETCH_RETRIES = 5;
const FETCH_PAUSE_MS = 60000;
const numeric = (t: { i: unknown }) => typeof t.i === 'number';
const minuteOf = (iso: string) => iso.slice(0, 16) + ':00Z';

// what a reply shows the call did, from the worker's own counters
function observed(
	op: string,
	args: any,
	status: number,
	body: any,
	expect: Expect,
	unreached: boolean
): Partial<Seen> {
	// no response: taken as not reached, so no rows; the meter's rowsWritten checks it
	if (unreached) return {};
	if (status !== 200 || !body) {
		// the effect of a failed call is unknown, so it counts as the worst case
		return {
			writeRows: op === 'clear' ? 0 : (expect.rows ?? 0),
			cleanupRows: op === 'clear' ? (expect.rows ?? 0) : 0,
			internal: expect.internal ?? 0,
			external: expect.external ?? 0
		};
	}
	const out: Partial<Seen> = { writeRows: body.rows ?? 0, schemaRows: body.setupRows ?? 0 };
	if (op === 'clear') Object.assign(out, { writeRows: 0, cleanupRows: expect.rows ?? 0 });
	if (op === 'colo') out.external = body.probe ? 1 : 0;
	if (op === 'hop' && args.mode !== 'local')
		out.internal = body.timings.filter(numeric).length + (body.error ? 1 : 0);
	if (op === 'fan') out.internal = body.timings.filter(numeric).length + (body.error ? 1 : 0);
	// a forwarded call (rung 6c) made one stub call to the owner
	if (body.forwards) out.internal = body.forwards;
	return out;
}

export async function call(
	ctx: Ctx,
	meta: Meta,
	role: string,
	name: string,
	op: string,
	args: object = {},
	expect: Expect = {},
	hint?: string,
	once = false
): Promise<Reply> {
	const url = `${ctx.base}/${role}/${name}/${op}${hint ? `?hint=${hint}` : ''}`;
	for (let attempt = 0; ; attempt++) {
		ctx.counters.guard(expect);
		ctx.counters.issue(expect, attempt > 0);
		const ts = new Date().toISOString();
		const at = performance.now();
		let status = 0,
			text = '',
			colo: string | null = null,
			body: any = null,
			error: string | undefined;
		try {
			const response = await ctx.fetchImpl(url, {
				method: 'POST',
				body: JSON.stringify(args),
				headers: { authorization: `Bearer ${ctx.secret}`, 'content-type': 'application/json' },
				signal: AbortSignal.timeout(ctx.timeoutMs)
			});
			status = response.status;
			colo = response.headers.get('x-front-colo') || null;
			text = await response.text();
			try {
				body = JSON.parse(text);
			} catch {
				// a platform error page is not JSON
			}
		} catch (e) {
			error = redact(String(e));
		}
		const wallMs = performance.now() - at;
		const endTs = new Date().toISOString();
		const unreached = status === 0 && (error ?? '').includes('fetch failed');
		const seen = observed(op, args, status, body, expect, unreached);
		ctx.counters.record(meta.rung, { requests: 1, ...seen });
		const { timings, per, ...summary } = body ?? {};
		await ctx.sink({
			...summary,
			level: 'client',
			ts,
			endTs,
			startMinute: minuteOf(ts),
			endMinute: minuteOf(endTs),
			rung: meta.rung,
			shape: meta.shape,
			size: meta.size,
			repeat: meta.repeat,
			...meta.extra,
			role,
			object: name,
			op,
			attempt,
			status,
			wallMs,
			colo,
			error: error ?? (status === 200 ? summary.error : redact(text.slice(0, 300)))
		});
		for (const [kind, rows] of [
			['hop', timings],
			['put', per]
		] as const)
			for (const [index, item] of (rows ?? []).entries())
				await ctx.sink({
					level: 'inner',
					kind,
					rung: meta.rung,
					shape: meta.shape,
					size: meta.size,
					repeat: meta.repeat,
					...meta.extra,
					i: kind === 'put' ? index : item.i,
					ms: kind === 'put' ? item : item.ms
				});
		if (quotaExhausted(text)) throw new Abort('free quota exhausted');
		const patience = unreached ? FETCH_RETRIES : MAX_RETRIES;
		const retry = !once && (status === 0 || status === 404) && attempt < patience;
		if (!retry) return { status, wallMs, colo, body };
		await ctx.sleep(unreached ? FETCH_PAUSE_MS : 500);
	}
}

/** polls the worker until it answers; every poll is a counted client request */
export async function ready(ctx: Ctx, polls = 30) {
	for (let i = 0; i < polls; i++) {
		ctx.counters.guard({});
		ctx.counters.issue({}, i > 0);
		let ok = false;
		try {
			const response = await ctx.fetchImpl(`${ctx.base}/ready`, {
				headers: { authorization: `Bearer ${ctx.secret}` },
				signal: AbortSignal.timeout(ctx.timeoutMs)
			});
			await response.arrayBuffer();
			ok = response.ok;
		} catch {
			// not up yet
		}
		ctx.counters.record(0, { requests: 1 });
		if (ok) return;
		await ctx.sleep(1000);
	}
	throw new Abort('worker did not become ready');
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
};

const rotate = <T>(xs: T[], by: number) => xs.map((_, i) => xs[(i + by) % xs.length] as T);
const sizes = (c: Config) => c.rung1.sizesKiB;
const schema = (c: Config) => c.assumptions.schemaRowsPerTable;

// rung 5: colocated store, read-modify-write of one blob through sql.exec in one object
export async function rung5(ctx: Ctx) {
	const r = ctx.config.rung5;
	const size = r.sizeKiB * KIB;
	for (let k = 0; k < r.repeats; k++) {
		const name = `${ctx.run}-store-${k}`;
		const meta = (shape: string, n: number): Meta => ({
			rung: 5,
			shape,
			size,
			repeat: k,
			extra: { n }
		});
		await call(ctx, meta('init', 0), 'store', name, 'init', { size }, { rows: 1 + schema(ctx.config) });
		await call(ctx, meta('base', 0), 'store', name, 'rmw', { n: 0 });
		await call(ctx, meta('read', r.read), 'store', name, 'read', { n: r.read });
		for (const n of r.rmw) await call(ctx, meta('rmw', n), 'store', name, 'rmw', { n }, { rows: n });
		await call(ctx, meta('clear', 0), 'store', name, 'clear', {}, { rows: 1 });
		ctx.counters.progress(`rung5 repeat ${k}`);
	}
}

const nextMinute = () => 60000 - (Date.now() % 60000) + 3000;

// rung 6: spill through sql.exec, through unawaited put, and fill-only (no write), one invocation each
export async function rung6(ctx: Ctx) {
	const r = ctx.config.rung6;
	const size = r.mib * MIB;
	for (const mode of modes)
		await call(
			ctx,
			{ rung: 6, shape: `control-${mode}`, size: 0, repeat: -1 },
			`spill${mode}`,
			`${ctx.run}-ctl-${mode}`,
			'hold',
			{ ms: r.holdMs }
		);
	for (let k = 0; k < r.repeats; k++)
		for (const layout of layouts(ctx.config))
			for (const mode of modes) {
				const rows = mode === 'none' ? 0 : spillRows(r.mib, layout.pages);
				const name = `${ctx.run}-sp-${layout.name}-${mode}-${k}`;
				const meta = (shape: string): Meta => ({
					rung: 6,
					shape: `${shape}-${layout.name}-${mode}`,
					size,
					repeat: k,
					extra: { extentPages: layout.pages, rows }
				});
				// one object per minute window, so the per-minute meter rows stay attributable
				if (ctx.alignMinute) await ctx.sleep(nextMinute());
				await call(
					ctx,
					meta('spill'),
					`spill${mode}`,
					name,
					'spill',
					{ mib: r.mib, extentPages: layout.pages, seed: k },
					{ rows: rows + (mode === 'sql' ? schema(ctx.config) : 0) }
				);
				await call(ctx, meta('hold'), `spill${mode}`, name, 'hold', { ms: r.holdMs });
				await call(ctx, meta('clear'), `spill${mode}`, name, 'clear', {}, { rows });
				ctx.counters.progress(`rung6 ${layout.name} ${mode} repeat ${k}`);
			}
}

// a spill class's role is its name in lower case; the worker routes by the upper-case binding
const roleOf = (cls: string) => cls.toLowerCase();
async function aligned(ctx: Ctx) {
	if (ctx.alignMinute) await ctx.sleep(nextMinute());
}

// rung 6b: sql spill at each size, put at one size, and two 64 MiB arms (read back; drop and tail)
// every object is fresh, and every size and arm has its own class
export async function rung6b(ctx: Ctx) {
	const r = ctx.config.rung6b;
	const fresh = async (
		cls: string,
		mode: 'sql' | 'put',
		mib: number,
		repeat: number,
		arm: string
	) => {
		const rows = spillRows(mib, r.extentPages);
		const name = `${ctx.run}-b-${arm}-${repeat}`;
		const meta = (step: string): Meta => ({
			rung: '6b',
			shape: `${step}-${arm}`,
			size: mib * MIB,
			repeat,
			extra: { class: cls, arm, mode, mib, extentPages: r.extentPages, planned: rows }
		});
		await aligned(ctx);
		await call(
			ctx,
			meta('spill'),
			roleOf(cls),
			name,
			'spill',
			{ mib, extentPages: r.extentPages, seed: repeat },
			{ rows: rows + (mode === 'sql' ? schema(ctx.config) : 0) }
		);
		return { name, meta, rows, role: roleOf(cls) };
	};
	for (const [mode, cls] of [
		['sql', 'CtlSql'],
		['put', 'CtlPut']
	] as const)
		await call(
			ctx,
			{
				rung: '6b',
				shape: `control-${mode}`,
				size: 0,
				repeat: -1,
				extra: { class: cls, arm: 'controls' }
			},
			roleOf(cls),
			`${ctx.run}-b-${cls}`,
			'hold',
			{ ms: r.holdMs }
		);
	for (let k = 0; k < r.repeats; k++) {
		for (const [i, mib] of r.sizesMiB.entries()) {
			const o = await fresh(`Size${i}`, 'sql', mib, k, `size${mib}`);
			await call(ctx, o.meta('hold'), o.role, o.name, 'hold', { ms: r.holdMs });
			await call(ctx, o.meta('clear'), o.role, o.name, 'clear', {}, { rows: o.rows });
		}
		const put = await fresh('PutOne', 'put', r.putMiB, k, `put${r.putMiB}`);
		await call(ctx, put.meta('hold'), put.role, put.name, 'hold', { ms: r.holdMs });
		await call(ctx, put.meta('clear'), put.role, put.name, 'clear', {}, { rows: put.rows });
		const read = await fresh('ReadBack', 'sql', r.armMiB, k, `readback${r.armMiB}`);
		await call(ctx, read.meta('read'), read.role, read.name, 'readback', {
			mib: r.armMiB,
			extentPages: r.extentPages
		});
		await call(ctx, read.meta('hold'), read.role, read.name, 'hold', { ms: r.holdMs });
		await call(ctx, read.meta('clear'), read.role, read.name, 'clear', {}, { rows: read.rows });
		const drop = await fresh('Drop', 'sql', r.armMiB, k, `drop${r.armMiB}`);
		await call(ctx, drop.meta('hold'), drop.role, drop.name, 'hold', { ms: r.holdMs });
		await call(ctx, drop.meta('clear'), drop.role, drop.name, 'clear', {}, { rows: drop.rows });
		await call(ctx, drop.meta('tail'), drop.role, drop.name, 'hold', { ms: r.tailMs });
		ctx.counters.progress(`rung6b repeat ${k}`);
	}
}

// rung 6c: one object restarted at +5 to +20 minutes, the same 16 MiB as 4 KiB values and as
// 1 MiB extents, and an owner behind an executor; each arm has its own class, controls are one hold
export async function rung6c(ctx: Ctx) {
	const r = ctx.config.rung6c;
	const name = (...parts: (string | number)[]) => [ctx.run, 'c', ...parts].join('-');
	const meta = (
		cls: string,
		arm: string,
		shape: string,
		repeat: number,
		extra: Record<string, unknown> = {}
	): Meta => ({ rung: '6c', shape, size: 0, repeat, extra: { class: cls, arm, ...extra } });
	const schemaRows = schema(ctx.config);

	await call(
		ctx,
		meta('CtlRestart', 'controls', 'control-ping', -1),
		roleOf('CtlRestart'),
		name('ctl', 'CtlRestart'),
		'ping'
	);
	await call(
		ctx,
		meta('CtlRestart', 'controls', 'control', -1),
		roleOf('CtlRestart'),
		name('ctl', 'CtlRestart'),
		'hold',
		{ ms: r.holdMs }
	);
	for (const cls of ['CtlSmall', 'CtlSec', 'CtlSecExec'])
		await call(
			ctx,
			meta(cls, 'controls', 'control', -1),
			roleOf(cls),
			name('ctl', cls),
			'hold',
			{ ms: r.holdMs }
		);

	for (let k = 0; k < r.repeats; k++) {
		// the spill and the fresh instances share one name; each fresh instance starts at a target minute
		const rows = spillRows(r.restartMib, r.extentPages);
		const object = name('restart', k);
		const at = (shape: string, extra: Record<string, unknown> = {}) =>
			meta('Restart', 'restart', shape, k, {
				mode: 'sql',
				mib: r.restartMib,
				planned: rows,
				...extra
			});
		await aligned(ctx);
		const start = Date.now();
		await call(
			ctx,
			at('spill'),
			roleOf('Restart'),
			object,
			'spill',
			{ mib: r.restartMib, extentPages: r.extentPages, seed: k },
			{ rows: rows + schemaRows }
		);
		await call(ctx, at('hold'), roleOf('Restart'), object, 'hold', { ms: r.holdMs });
		for (const minute of r.minutes) {
			await ctx.sleep(Math.max(0, start + minute * 60000 - Date.now()));
			await call(ctx, at(`ping-${minute}`, { minute }), roleOf('Restart'), object, 'ping');
			await call(ctx, at(`fresh-${minute}`, { minute }), roleOf('Restart'), object, 'hold', {
				ms: r.holdMs
			});
		}
		await call(ctx, at('clear'), roleOf('Restart'), object, 'clear', {}, { rows });

		for (const [cls, arm, rowBytes, planned] of [
			['SmallRows', 'small4k', r.smallRowBytes, rowsOfBytes(r.smallMib, r.smallRowBytes)],
			['SmallExt', 'smallExt', r.extentPages * PAGE, spillRows(r.smallMib, r.extentPages)]
		] as const) {
			const small = name(arm, k);
			const at = (shape: string) =>
				meta(cls, arm, shape, k, { mode: 'sql', mib: r.smallMib, rowBytes, planned });
			await aligned(ctx);
			await call(
				ctx,
				at('spill'),
				roleOf(cls),
				small,
				'spill',
				{ mib: r.smallMib, rowBytes, seed: k },
				{ rows: planned + schemaRows }
			);
			await call(ctx, at('hold'), roleOf(cls), small, 'hold', { ms: r.holdMs });
			await call(ctx, at('clear'), roleOf(cls), small, 'clear', {}, { rows: planned });
		}

		// the executor forwards spill, hold and clear to the owner of the same name
		const second = name('sec', k);
		const rowsSec = spillRows(r.secondMib, r.extentPages);
		const at2 = (shape: string) =>
			meta('SecOwn', 'second', shape, k, {
				caller: 'SecExec',
				mode: 'sql',
				mib: r.secondMib,
				planned: rowsSec
			});
		await aligned(ctx);
		await call(
			ctx,
			at2('spill'),
			roleOf('SecExec'),
			second,
			'spill',
			{ mib: r.secondMib, extentPages: r.extentPages, seed: k, owner: second },
			{ rows: rowsSec + schemaRows, internal: 1 }
		);
		await call(
			ctx,
			at2('hold'),
			roleOf('SecExec'),
			second,
			'hold',
			{ ms: r.holdMs, owner: second },
			{ internal: 1 }
		);
		await call(
			ctx,
			at2('clear'),
			roleOf('SecExec'),
			second,
			'clear',
			{ owner: second },
			{ rows: rowsSec, internal: 1 }
		);
		ctx.counters.progress(`rung6c repeat ${k}`);
	}
}

// one step of a spilled object: the arguments and the worst case the plan allows it
interface Step {
	args: object;
	expect: Expect;
}

// a spilled object of rung 6d: spill, holds, then the clear
interface Spilled {
	meta: (shape: string, extra?: Record<string, unknown>) => Meta;
	role: string;
	name: string;
	spill: Step;
	holds: number;
	hold: Step;
	clear: Step;
	probe: Step & { op: string };
}

const FAILED_PROBES = 5;

// a step that fails ends the object; its clear waits for a probe to answer 200, else is skipped
async function spilled(ctx: Ctx, o: Spilled) {
	await aligned(ctx);
	const run = (
		shape: string,
		op: string,
		s: Step,
		extra?: Record<string, unknown>,
		once = false
	) => call(ctx, o.meta(shape, extra), o.role, o.name, op, s.args, s.expect, undefined, once);
	let ok = (await run('spill', 'spill', o.spill)).status === 200;
	for (let i = 1; ok && i <= o.holds; i++)
		ok = (await run('hold', 'hold', o.hold, { hold: i })).status === 200;
	for (let poll = 0; !ok && poll < FAILED_PROBES; poll++) {
		await ctx.sleep(FETCH_PAUSE_MS);
		ok = (await run('probe', o.probe.op, o.probe, undefined, true)).status === 200;
	}
	if (ok) await run('clear', 'clear', o.clear);
	else
		await ctx.sink({
			level: 'client',
			rung: '6d',
			shape: 'clear-skipped',
			role: o.role,
			object: o.name,
			op: 'skip',
			ts: new Date().toISOString()
		});
}

// one row-size arm of rung 6d or 6e: spill it as rows, hold once, then clear
async function rowArm(
	ctx: Ctx,
	rung: '6d' | '6e',
	tag: string,
	arm: RowArm,
	k: number,
	holdMs: number
) {
	const rowBytes = arm.rowKiB * KIB;
	const planned = rowsOfBytes(arm.mib, rowBytes);
	await spilled(ctx, {
		meta: (shape, extra = {}) => ({
			rung,
			shape,
			size: arm.mib * MIB,
			repeat: k,
			extra: {
				class: arm.cls,
				arm: arm.arm,
				mode: 'sql',
				mib: arm.mib,
				rowBytes,
				planned,
				...extra
			}
		}),
		role: roleOf(arm.cls),
		name: [ctx.run, tag, arm.arm, k].join('-'),
		spill: {
			args: { mib: arm.mib, rowBytes, seed: k },
			expect: { rows: planned + schema(ctx.config) }
		},
		holds: 1,
		hold: { args: { ms: holdMs }, expect: {} },
		clear: { args: {}, expect: { rows: planned } },
		probe: { op: 'ping', args: {}, expect: {} }
	});
}

// rung 6d: the row sweep, a 64 MiB decay and the second object once more; one class per arm.
// a round runs repeat k of every arm that has one, so a class sees its next object a round later
export async function rung6d(ctx: Ctx) {
	const r = ctx.config.rung6d;
	const rowsSchema = schema(ctx.config);
	const name = (...parts: (string | number)[]) => [ctx.run, 'd', ...parts].join('-');
	for (const cls of ['CtlSmall', 'CtlSec', 'CtlSecExec'])
		await call(
			ctx,
			{
				rung: '6d',
				shape: 'control',
				size: 0,
				repeat: -1,
				extra: { class: cls, arm: 'controls' }
			},
			roleOf(cls),
			name('ctl', cls),
			'hold',
			{ ms: r.holdMs }
		);
	const rounds = Math.max(r.decay.repeats, r.secondRepeats, ...r.rows.map((a) => a.repeats));
	for (let k = 0; k < rounds; k++) {
		for (const arm of r.rows)
			if (k < arm.repeats) await rowArm(ctx, '6d', 'd', arm, k, r.holdMs);
		if (k < r.decay.repeats) {
			const { mib, holds } = r.decay;
			const rows = spillRows(mib, r.extentPages);
			await spilled(ctx, {
				meta: (shape, extra = {}) => ({
					rung: '6d',
					shape,
					size: mib * MIB,
					repeat: k,
					extra: {
						class: 'Decay',
						arm: 'decay',
						mode: 'sql',
						mib,
						extentPages: r.extentPages,
						planned: rows,
						...extra
					}
				}),
				role: roleOf('Decay'),
				name: name('decay', k),
				spill: {
					args: { mib, extentPages: r.extentPages, seed: k },
					expect: { rows: rows + rowsSchema }
				},
				holds,
				hold: { args: { ms: r.holdMs }, expect: {} },
				clear: { args: {}, expect: { rows } },
				probe: { op: 'ping', args: {}, expect: {} }
			});
		}
		if (k < r.secondRepeats) {
			const rows = spillRows(r.secondMib, r.extentPages);
			const object = name('sec', k);
			await spilled(ctx, {
				meta: (shape, extra = {}) => ({
					rung: '6d',
					shape,
					size: r.secondMib * MIB,
					repeat: k,
					extra: {
						class: 'SecOwn',
						arm: 'second',
						caller: 'SecExec',
						mode: 'sql',
						mib: r.secondMib,
						planned: rows,
						...extra
					}
				}),
				role: roleOf('SecExec'),
				name: object,
				spill: {
					args: { mib: r.secondMib, extentPages: r.extentPages, seed: k, owner: object },
					expect: { rows: rows + rowsSchema, internal: 1 }
				},
				holds: 1,
				hold: { args: { ms: r.holdMs, owner: object }, expect: { internal: 1 } },
				clear: { args: { owner: object }, expect: { rows, internal: 1 } },
				probe: { op: 'hold', args: { ms: 0, owner: object }, expect: { internal: 1 } }
			});
		}
		ctx.counters.progress(`rung6d round ${k}`);
	}
}

// rung 6e: 16 MiB as 8 and 6 KiB rows, 64 MiB as 4 KiB rows; one class per arm, CtlSmall idles
export async function rung6e(ctx: Ctx) {
	const r = ctx.config.rung6e;
	await call(
		ctx,
		{
			rung: '6e',
			shape: 'control',
			size: 0,
			repeat: -1,
			extra: { class: 'CtlSmall', arm: 'controls' }
		},
		roleOf('CtlSmall'),
		[ctx.run, 'e', 'ctl', 'CtlSmall'].join('-'),
		'hold',
		{ ms: r.holdMs }
	);
	const rounds = Math.max(...r.rows.map((a) => a.repeats));
	for (let k = 0; k < rounds; k++) {
		for (const arm of r.rows)
			if (k < arm.repeats) await rowArm(ctx, '6e', 'e', arm, k, r.holdMs);
		ctx.counters.progress(`rung6e round ${k}`);
	}
}

// rung 4: a CPU-bound request, calibrated on the wall time of a ladder of loop counts
export async function rung4(ctx: Ctx) {
	const r = ctx.config.rung4;
	const name = `${ctx.run}-burn`;
	const meta = (shape: string, extra: Record<string, unknown> = {}): Meta => ({
		rung: 4,
		shape,
		size: 0,
		repeat: 0,
		extra
	});
	const noop: number[] = [];
	for (let i = 0; i < r.noops; i++) {
		const reply = await call(ctx, meta('noop', { warmup: i === 0 }), 'burn', name, 'ping');
		if (i > 0 && reply.status === 200) noop.push(reply.wallMs);
	}
	const base = median(noop);
	let slope = 0,
		lastIters = r.ladder.at(-1)!,
		killed: number | null = null;
	for (const iters of r.ladder) {
		const reply = await call(ctx, meta('ladder', { iters }), 'burn', name, 'burn', { iters });
		if (reply.status !== 200) {
			killed = iters;
			break;
		}
		slope = Math.max(0, reply.wallMs - base) / iters;
		lastIters = iters;
	}
	ctx.counters.progress('rung4 ladder');
	if (killed !== null) return { killed, slope };
	for (const target of r.targetsMs) {
		const iters = Math.max(
			1,
			Math.min(Math.round(target / (slope || 1e-9)), (lastIters * target) / 25)
		);
		for (let k = 0; k < r.repeats; k++)
			await call(
				ctx,
				{ rung: 4, shape: `burn-${target}ms`, size: 0, repeat: k, extra: { target, iters, slope } },
				'burn',
				name,
				'burn',
				{ iters }
			);
	}
	ctx.counters.progress('rung4');
	return { killed, slope };
}

// rung 1: sixteen writes in one owner, three shapes, a no-op call per repeat as the base
export async function rung1(ctx: Ctx) {
	const r = ctx.config.rung1;
	const name = `${ctx.run}-w`;
	const shapes = ['await', 'noawait', 'sql'];
	let table = false;
	for (let k = 0; k < r.repeats; k++) {
		await call(
			ctx,
			{ rung: 1, shape: 'none', size: 0, repeat: k, extra: { n: 0 } },
			'own',
			name,
			'write',
			{ shape: 'none', size: 0, n: 0 }
		);
		for (const [s, kib] of sizes(ctx.config).entries())
			for (const shape of rotate(shapes, k + s)) {
				const first = shape === 'sql' && !table;
				if (shape === 'sql') table = true;
				await call(
					ctx,
					{ rung: 1, shape, size: kib * KIB, repeat: k, extra: { n: r.n } },
					'own',
					name,
					'write',
					{ shape, size: kib * KIB, n: r.n, seed: k },
					{ rows: r.n + (first ? schema(ctx.config) : 0) }
				);
			}
		if (k % 5 === 4) ctx.counters.progress(`rung1 repeat ${k}`);
	}
	await call(
		ctx,
		{ rung: 1, shape: 'clear', size: 0, repeat: 0 },
		'own',
		name,
		'clear',
		{},
		{ rows: 3 * r.n }
	);
	ctx.counters.progress('rung1');
}

// rung 2: sequential no-op calls from an executor to an owner
export async function rung2(ctx: Ctx) {
	const r = ctx.config.rung2;
	const calls = r.n + 1;
	for (let k = 0; k < r.repeats; k++) {
		for (const hinted of [false, true]) {
			const hint = hinted ? r.hint : undefined;
			const tag = hinted ? 'h1' : 'h0';
			const exec = `${ctx.run}-${tag}-e${k}`,
				owner = `${ctx.run}-${tag}-o${k}`;
			const meta = (shape: string): Meta => ({
				rung: 2,
				shape: `${shape}/${tag}`,
				size: 0,
				repeat: k,
				extra: { hint: hint ?? null, n: r.n }
			});
			if (r.coloProbe) {
				await call(ctx, meta('colo-owner'), 'own', owner, 'colo', {}, { external: 1 }, hint);
				await call(ctx, meta('colo-exec'), 'exec', exec, 'colo', {}, { external: 1 }, hint);
			}
			const modeList = hinted ? ['fetch', 'rpc'] : ['fetch', 'rpc', 'local', 'selfstub'];
			for (const mode of modeList)
				await call(
					ctx,
					meta(mode),
					'exec',
					exec,
					'hop',
					{ mode, owner, hint, n: r.n },
					{ internal: mode === 'local' ? 0 : calls },
					hint
				);
		}
		ctx.counters.progress(`rung2 repeat ${k}`);
	}
}

// rung 3: how many stub calls one invocation can make
export async function rung3(ctx: Ctx) {
	const r = ctx.config.rung3;
	const kinds: [string, number][] = [
		['seq', r.seq],
		['seqrpc', r.rpcSeq],
		['allfetch', r.fan],
		['allrpc', r.fan]
	];
	for (let k = 0; k < r.repeats; k++) {
		const exec = `${ctx.run}-f-e${k}`,
			owner = `${ctx.run}-f-o${k}`;
		for (const [kind, count] of kinds)
			await call(
				ctx,
				{ rung: 3, shape: kind, size: 0, repeat: k, extra: { count } },
				'exec',
				exec,
				'fan',
				{ kind, count, owner },
				{ internal: count + 1 }
			);
		ctx.counters.progress(`rung3 repeat ${k}`);
	}
}

/** the order rung 7 runs its instances in: every cell once per repeat, rotated, bares at the ends */
export function memOrder(c: Config) {
	const cells = memCells(c);
	const order: { cls: number; mib: number; touch: boolean | null; repeat: number }[] = [];
	let cls = 0;
	const bares = c.rung7.bare;
	const bare = (repeat: number) => order.push({ cls: cls++, mib: 0, touch: null, repeat });
	if (bares > 0) bare(0);
	for (let k = 0; k < c.rung7.repeats; k++)
		for (const cell of rotate(cells, k)) order.push({ cls: cls++, ...cell, repeat: k });
	for (let b = 1; b < bares; b++) bare(b);
	return order;
}

// rung 7: the platform memory meter at two linear sizes, written and untouched
export async function rung7(ctx: Ctx, names: string[]) {
	const r = ctx.config.rung7;
	const order = memOrder(ctx.config);
	for (const cell of order) {
		const cls = names[cell.cls] as string;
		const shape = cell.touch === null ? 'bare' : cell.touch ? 'written' : 'untouched';
		const meta = (step: string): Meta => ({
			rung: 7,
			shape: `${step}-${shape}`,
			size: cell.mib * MIB,
			repeat: cell.repeat,
			extra: { class: cls }
		});
		if (cell.touch !== null) {
			const alloc = await call(ctx, meta('alloc'), cls, 'cell', 'alloc', { mib: cell.mib });
			if (alloc.status !== 200) continue;
			if (cell.touch)
				for (let from = 0; from < cell.mib; from += r.touchChunkMiB)
					await call(ctx, meta('touch'), cls, 'cell', 'touch', {
						from,
						mib: Math.min(r.touchChunkMiB, cell.mib - from)
					});
		}
		await call(ctx, meta('hold'), cls, 'cell', 'hold', { ms: r.holdMs });
		ctx.counters.progress(`rung7 ${cls}`);
	}
	return order;
}

const ladderRungs = { 5: rung5, 6: rung6, 4: rung4, 1: rung1, 2: rung2, 3: rung3 } as const;

/** rungs 5, 6, 4, 1, 2 and 3 on the ladder script, cheapest first */
export async function runLadder(ctx: Ctx, rungs: readonly Rung[]) {
	await ready(ctx);
	for (const rung of [5, 6, 4, 1, 2, 3] as const)
		if (rungs.includes(rung)) await ladderRungs[rung](ctx);
}

/** rungs 6b, 6c and 6d on the spill script, which holds only the spill classes */
export async function runSpill(ctx: Ctx, rungs: readonly Rung[]) {
	await ready(ctx);
	if (rungs.includes('6b')) await rung6b(ctx);
	if (rungs.includes('6c')) await rung6c(ctx);
	if (rungs.includes('6d')) await rung6d(ctx);
	if (rungs.includes('6e')) await rung6e(ctx);
}

export async function runMem(ctx: Ctx, names: string[]) {
	await ready(ctx);
	return rung7(ctx, names);
}
