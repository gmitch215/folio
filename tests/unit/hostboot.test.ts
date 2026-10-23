import { deflateRawSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import {
	bodyHash,
	budgetFromEnv,
	cpuByTag,
	median,
	normalizeBody,
	outcomes,
	pairedCpu,
	saving,
	summarizeArm,
	summarizeRun,
	withinBudget,
	type StepRow
} from '../../experiments/bootimage/hostboot-analyze.ts';
import { readMeter } from '../../experiments/consumer/drive.ts';
import { credentials, inventoryDiff } from '../../experiments/lib/cloudflare.ts';
import {
	bakedSource,
	chunkImage,
	differingPages,
	getterGlobals,
	joinRows,
	pageHash,
	pibInitReplay,
	reassemble
} from '../../scripts/probe/product-bake.ts';

const PAGE = 65_536;

const event = (entrypoint: string | undefined, path: string, cpuTime: number, outcome = 'ok') =>
	JSON.stringify(
		{
			...(entrypoint ? { entrypoint } : {}),
			outcome,
			cpuTime,
			wallTime: cpuTime + 5,
			executionModel: 'durableObject',
			event: { request: { url: `https://x.example${path}`, headers: {} } }
		},
		null,
		2
	);

test('normalizeBody removes the per-render ids and keeps the rest', () => {
	const a = `<div class="js-view-dom-id-${'a'.repeat(64)}"><input name="form_build_id" value="form-${'b'.repeat(43)}"></div>`;
	const b = a.replace(/a{64}/, 'c'.repeat(64)).replace(/b{43}/, 'd'.repeat(43));
	expect(normalizeBody(a)).toBe(normalizeBody(b));
	expect(bodyHash(a)).toBe(bodyHash(b));
	expect(bodyHash(a + 'x')).not.toBe(bodyHash(a));
});

test('median and saving', () => {
	expect(median([3, 1, 2])).toBe(2);
	expect(median([4, 1, 2, 3])).toBe(2.5);
	const arm = (cpu: number[], wall: number[]) =>
		({ cpu: { median: median(cpu) }, wall: { median: median(wall) } }) as any;
	const s = saving(
		arm([1000, 1100, 900], [2000, 2200, 1800]),
		arm([500, 520, 480], [1000, 900, 1100])
	);
	expect(s.cpuRatio).toBeCloseTo(0.5, 3);
	expect(s.cpuSavingPercent).toBeCloseTo(50, 1);
	expect(s.wallSavingPercent).toBeCloseTo(50, 1);
});

test('cpuByTag joins one object invocation per tag and ignores the front worker', () => {
	const tail = [
		event(undefined, '/hostbody?site=a&path=/&tag=t1', 3),
		event('SitePhpDurableObject', '/__hostbody?site=a&path=/&tag=t1', 1100),
		event('SitePhpDurableObject', '/__hostbody?site=b&path=/&tag=t2', 400, 'exceededMemory')
	].join('\n');
	const joined = cpuByTag(tail, ['t1', 't2', 't3']);
	const prefixed = cpuByTag(
		[tail, event('SitePhpDurableObject', '/__hostprobe?tag=t1csrf', 9)].join('\n'),
		['t1']
	);
	expect(prefixed.t1?.cpuMs).toBe(1100);
	expect(joined.t1?.cpuMs).toBe(1100);
	expect(joined.t2?.outcome).toBe('exceededMemory');
	expect(joined.t3).toBeUndefined();
	expect(outcomes(tail)).toEqual({ ok: 2, exceededMemory: 1 });
});

test('summarizeArm reports missing tags and pairs rounds', () => {
	const rows: StepRow[] = [];
	const tails: string[] = [];
	for (const [arm, cpus] of [
		['control', [1000, 1100, 1200]],
		['baked', [400, 450, 500]]
	] as const) {
		cpus.forEach((cpu, i) => {
			const tag = `${arm}${i}`;
			rows.push({
				arm,
				object: tag,
				kind: 'measure',
				tag,
				wallMs: cpu + 300,
				status: 200,
				bytes: 17686,
				bodyHash: 'h',
				warm: arm === 'baked' ? 1 : 0
			});
			if (!(arm === 'baked' && i === 2))
				tails.push(event('Obj', `/__hostbody?tag=${tag}`, cpu));
		});
	}
	const tail = tails.join('\n');
	const control = summarizeArm('control', rows, tail);
	const baked = summarizeArm('baked', rows, tail);
	expect(control.cpu).toEqual({ n: 3, median: 1100, min: 1000, max: 1200 });
	expect(baked.missingCpu).toEqual(['baked2']);
	expect(baked.cpu.n).toBe(2);
	expect(pairedCpu(rows, tail, 'control', 'baked')).toHaveLength(2);
});

test('withinBudget stops on rows, requests and per-arm requests', () => {
	const budget = { maxRowsWritten: 60_000, maxRequests: 500, maxRequestsPerArm: 40 };
	const spent = { rowsWritten: 10_000, requests: 100, perArm: { control: 30 } };
	expect(withinBudget(budget, spent, 'control', 6)).toBe(true);
	expect(withinBudget(budget, spent, 'control', 11)).toBe(false);
	expect(withinBudget(budget, { ...spent, rowsWritten: 60_001 }, 'baked', 1)).toBe(false);
	expect(withinBudget(budget, { ...spent, requests: 496 }, 'baked', 6)).toBe(false);
});

test('budgetFromEnv lowers a limit and refuses a higher or invalid one', () => {
	expect(budgetFromEnv({})).toEqual({
		maxRowsWritten: 60_000,
		maxRequests: 500,
		maxRequestsPerArm: 40
	});
	expect(budgetFromEnv({ HOSTBOOT_MAX_ROWS: '36500', HOSTBOOT_MAX_REQUESTS: '300' })).toEqual({
		maxRowsWritten: 36_500,
		maxRequests: 300,
		maxRequestsPerArm: 40
	});
	expect(() => budgetFromEnv({ HOSTBOOT_MAX_ROWS: '60001' })).toThrow(RangeError);
	expect(() => budgetFromEnv({ HOSTBOOT_MAX_ARM_REQUESTS: 'x' })).toThrow(RangeError);
});

test('joinRows inflates, stores raw rows as they are, and refuses a gap or a wrong length', () => {
	const a = new Uint8Array(1000).fill(7);
	const b = new Uint8Array(500).fill(9);
	const rows = [
		{ seq: 1, bytes: b, raw_bytes: 0 },
		{ seq: 0, bytes: new Uint8Array(deflateRawSync(a)), raw_bytes: a.length }
	];
	const joined = joinRows(rows);
	expect(joined.length).toBe(1500);
	expect(joined[0]).toBe(7);
	expect(joined[1499]).toBe(9);
	expect(() => joinRows([{ seq: 1, bytes: b, raw_bytes: 0 }])).toThrow(/missing/);
	expect(() =>
		joinRows([{ seq: 0, bytes: new Uint8Array(deflateRawSync(a)), raw_bytes: 999 }])
	).toThrow(/inflated/);
});

test('reassemble puts kept pages at their numbers and zero elsewhere', () => {
	const kept = new Uint8Array(2 * PAGE);
	kept.fill(1, 0, PAGE);
	kept.fill(2, PAGE);
	const heap = reassemble(kept, [1, 3], 5 * PAGE);
	expect(heap[0]).toBe(0);
	expect(heap[PAGE]).toBe(1);
	expect(heap[3 * PAGE]).toBe(2);
	expect(heap[4 * PAGE]).toBe(0);
	expect(() => reassemble(kept, [1, 9], 5 * PAGE)).toThrow(/outside/);
	expect(() => reassemble(kept, [1], 5 * PAGE)).toThrow(/kept pages/);
	const other = heap.slice();
	other[3 * PAGE + 5] = 9;
	expect(differingPages(heap, other)).toBe(1);
	expect(differingPages(heap, heap.slice())).toBe(0);
});

test('pibInitReplay keeps only pib_init calls and zeroes the stack pointers', () => {
	const trace = [
		{ stage: 'pib_storage_init', key: 'emscripten_asm_const_int', args: [1, 2, 3] },
		{ stage: 'pib_init', key: 'emscripten_asm_const_int', args: [4216265, 37915359, 0] },
		{ stage: '', key: 'emscripten_asm_const_int', args: [5, 6, 7] }
	];
	expect(pibInitReplay(trace)).toEqual([
		{ stage: 'pib_init', key: 'emscripten_asm_const_int', args: [4216265, 0, 0] }
	]);
});

test('bakedSource writes a null image for a control and the image for a bake', () => {
	expect(bakedSource(null)).toContain('export const BAKED: BakedMeta | null = null;');
	const text = bakedSource({
		pages: 1358,
		context: 'g|d|',
		asm: [],
		streams: [],
		handles: [{ id: 1, name: '@globalThis' }],
		image: 'ab',
		plainFallback: true
	});
	expect(text).toContain("import plain from '../../.interp/php8.5.plain.wasm';");
	expect(text).toContain('"pages": 1358');
	expect(text).toContain('(plain as unknown as WebAssembly.Module)');
	expect(
		bakedSource({
			pages: 1,
			context: 'c',
			asm: [],
			streams: [],
			handles: [],
			image: 'x',
			plainFallback: false
		})
	).toContain('PLAIN_MODULE: WebAssembly.Module | null = null');
});

test('pageHash gives the same value for a page at an offset that is not a multiple of 4', () => {
	const page = new Uint8Array(PAGE);
	page.forEach((_, i) => (page[i] = (i * 7) & 255));
	const shifted = new Uint8Array(PAGE + 3);
	shifted.set(page, 3);
	expect(pageHash(shifted.subarray(3, 3 + PAGE))).toBe(pageHash(page));
});

test('getterGlobals finds the mutable global a getter export reads and its initial value', async () => {
	const binaryen = (await import('binaryen')).default;
	const mod = binaryen.parseText(`(module
		(global $stack (mut i32) (i32.const 7))
		(global $fixed i32 (i32.const 9))
		(global $limit (mut i32) (i32.const 0))
		(func $getStack (result i32) (global.get $stack))
		(func $getLimit (result i32) (global.get $limit))
		(func $getFixed (result i32) (global.get $fixed))
		(export "stack" (func $getStack))
		(export "limit" (func $getLimit))
		(export "fixed" (func $getFixed)))`);
	const wasm = mod.emitBinary();
	mod.dispose();
	expect(await getterGlobals(wasm, ['stack', 'limit', 'fixed', 'absent'])).toEqual({
		stack: { index: 0, initial: 7 },
		limit: { index: 2, initial: 0 }
	});
});

test('chunkImage splits pages into files with an index of numbers and hashes', () => {
	const pages = [2, 5, 6, 9, 10];
	const data = new Uint8Array(pages.length * PAGE);
	pages.forEach((_, i) => data.fill(i + 1, i * PAGE, (i + 1) * PAGE));
	const { index, files } = chunkImage(
		{ byteLength: 12 * PAGE, pages, data, module: 'a'.repeat(64) },
		2
	);
	expect(index.memoryPages).toBe(12);
	expect(index.chunks.map((c) => c.file)).toEqual(['c000.bin', 'c001.bin', 'c002.bin']);
	expect(index.chunks.map((c) => c.pages)).toEqual([[2, 5], [6, 9], [10]]);
	expect(files['c002.bin']!.length).toBe(PAGE);
	expect(index.chunks[0]!.hashes[1]).toBe(pageHash(data.subarray(PAGE, 2 * PAGE)));
	expect(index.chunks[0]!.hashes[0]).not.toBe(index.chunks[0]!.hashes[1]);
	expect(() =>
		chunkImage({ byteLength: PAGE, pages: [0], data: new Uint8Array(PAGE) }, 0)
	).toThrow(/chunkPages/);
});

test('summarizeRun reports delivery probes joined to their invocation', () => {
	const tail = event('SitePhpDurableObject', '/__hostdeliver?site=d0&check=0&tag=d0', 130);
	const rows: StepRow[] = [
		{
			arm: 'baked',
			object: 'd0',
			kind: 'deliver',
			tag: 'd0',
			status: 200,
			wallMs: 1100,
			delivery: { totalMs: 300 }
		}
	];
	const summary = summarizeRun(rows, { baked: tail });
	expect(summary.delivery).toEqual([
		{ tag: 'd0', status: 200, wallMs: 1100, cpuMs: 130, totalMs: 300 }
	]);
});

test('bakedSource carries the booted globals and the stream fields the replay uses', () => {
	const text = bakedSource({
		pages: 1,
		context: 'c',
		asm: [],
		streams: [{ fd: 3, path: '/dev/urandom', flags: 32768, position: 4, seekable: false }],
		handles: [],
		image: 'x',
		globals: { emscripten_stack_get_end: 4416480 },
		plainFallback: false
	});
	expect(text).toContain('"emscripten_stack_get_end": 4416480');
	expect(text).toContain('"seekable": false');
	expect(text).toContain('globals?: Record<string, number>;');
});

test('bakedSource carries the config digest when one is given', () => {
	const text = bakedSource({
		pages: 1,
		context: 'c',
		asm: [],
		streams: [],
		handles: [],
		image: 'x',
		assets: 'hostboot/index.json',
		config: 'abc',
		plainFallback: false
	});
	expect(text).toContain('"config": "abc"');
	expect(text).toContain('"assets": "hostboot/index.json"');
});

test('runCase drives migrate, seed, render, edit, drop and a cold render in order', async () => {
	const { runCase } = await import('../../experiments/bootimage/stale.ts');
	const seen: string[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		const path = new URL(url).pathname;
		seen.push(path);
		const html = `<title>Welcome | ${path === '/hostbody' && seen.length > 7 ? 'Renamed Site' : 'Old'}</title>`;
		const body =
			path === '/hostbody'
				? {
						php: {
							runs: [{ status: 200, bytes: html.length, body: html }],
							warmInterpreter: 0
						},
						boot: { baked: false }
					}
				: { out: { ok: 1 }, context: 'ctx' };
		return new Response(JSON.stringify(body));
	}) as typeof fetch;
	try {
		const steps = await runCase('http://x.example', 's', 'rename', 'key=a&salt=b');
		expect(seen).toEqual([
			'/migrate',
			'/migrate',
			'/hostseed',
			'/hostbody',
			'/hostphp',
			'/hostbody',
			'/hostdrop',
			'/hostbody'
		]);
		expect(steps.map((s) => s.step)).toEqual([
			'first',
			'edit',
			'warm after edit',
			'drop',
			'cold after edit'
		]);
		expect(steps[0]!.markers).toEqual([]);
		expect(steps[4]!.markers).toEqual(['Renamed Site']);
	} finally {
		globalThis.fetch = real;
	}
});

test('summarizeRun lists phase rows with the cpuTime of their invocation', () => {
	const tail = event('SitePhpDurableObject', '/__php?site=a&tag=p1', 430);
	const rows: StepRow[] = [
		{
			arm: 'baked',
			object: 'a',
			kind: 'phase',
			phase: 'boot-only',
			tag: 'p1',
			status: 200,
			wallMs: 1000,
			delivery: { bootMs: 5 }
		}
	];
	expect(summarizeRun(rows, { baked: tail }).phases).toEqual([
		{
			arm: 'baked',
			object: 'a',
			phase: 'boot-only',
			status: 200,
			wallMs: 1000,
			cpuMs: 430,
			bootMs: 5
		}
	]);
});

test('summarizeRun keeps the serve-after-drop rows of each arm apart from first and re-boot', () => {
	const rows: StepRow[] = [];
	const tails: string[] = [];
	for (const [arm, cpu] of [
		['control', 800],
		['par', 200]
	] as const) {
		rows.push({
			arm: `${arm}-serve`,
			object: `${arm}0`,
			kind: 'measure',
			tag: `${arm}s`,
			wallMs: cpu
		});
		tails.push(event('Obj', `/__hostbody?tag=${arm}s`, cpu));
	}
	const all = tails.join('\n');
	const summary = summarizeRun(rows, { control: all, par: all });
	expect(Object.keys(summary.saving)).toEqual(['par-serve']);
	expect(summary.saving['par-serve'].cpuRatio).toBeCloseTo(0.25, 3);
});

test('summarizeRun compares every arm with the control and keeps first and re-boot apart', () => {
	const rows: StepRow[] = [];
	const tails: string[] = [];
	const cpus: Record<string, number[]> = {
		control: [1000, 1100],
		seq: [600, 640],
		par: [500, 560]
	};
	for (const [arm, list] of Object.entries(cpus))
		list.forEach((cpu, i) => {
			for (const [suffix, factor] of [
				['', 1],
				['-reboot', 0.5]
			] as const) {
				const tag = `${arm}${suffix === '' ? 'f' : 'r'}${i}`;
				rows.push({
					arm: `${arm}${suffix}`,
					object: `${arm}${i}`,
					kind: 'measure',
					tag,
					wallMs: cpu * factor
				});
				tails.push(event('Obj', `/__hostbody?tag=${tag}`, cpu * factor));
			}
		});
	const all = tails.join('\n');
	const summary = summarizeRun(rows, { control: all, seq: all, par: all });
	expect(Object.keys(summary.saving).sort()).toEqual([
		'par-first',
		'par-reboot',
		'seq-first',
		'seq-reboot'
	]);
	expect(summary.saving['par-first'].cpuRatio).toBeCloseTo(530 / 1050, 3);
	expect(summary.arms['control-reboot'].cpu.median).toBe(525);
});

test('inventoryDiff names what the caller made and only hashes what it did not', () => {
	const mine = (e: Record<string, unknown>) => String(e.name).startsWith('cfw-folio-hostboot-');
	const before = {
		scripts: [{ name: 'live-site', modified: 'a' }],
		namespaces: [],
		kv: [{ name: 'live-kv', id: '1' }],
		r2: null,
		d1: []
	};
	const after = {
		scripts: [
			{ name: 'live-site', modified: 'b' },
			{ name: 'cfw-folio-hostboot-control-x', modified: 'c' }
		],
		namespaces: [],
		kv: [{ name: 'live-kv', id: '1' }],
		r2: null,
		d1: []
	};
	const diff = inventoryDiff(before, after, mine);
	expect(diff).toHaveLength(2);
	expect(diff.find((d) => d.mine)).toMatchObject({
		type: 'scripts',
		change: 'added',
		ref: 'cfw-folio-hostboot-control-x'
	});
	const foreign = diff.find((d) => !d.mine)!;
	expect(foreign).toMatchObject({ type: 'scripts', change: 'modified' });
	expect(foreign.ref).toMatch(/^[0-9a-f]{8}$/);
	expect(inventoryDiff(before, before, mine)).toEqual([]);
});

test('readMeter asks for the day it is given and sums the groups', async () => {
	const bodies: any[] = [];
	vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		return Response.json({
			data: {
				viewer: {
					accounts: [
						{
							w: [{ sum: { requests: 2 } }, { sum: { requests: 3 } }],
							d: [{ sum: { requests: 4 } }],
							p: [{ sum: { duration: 1.5, rowsRead: 7, rowsWritten: 9 } }]
						}
					]
				}
			}
		});
	});
	try {
		const meter = await readMeter('acct', 'token', '2026-10-01');
		expect(bodies[0].variables.d).toBe('2026-10-01');
		expect(meter).toEqual({
			workerRequests: 5,
			durableObjectRequests: 4,
			durableObjectDurationGbS: 1.5,
			rowsRead: 7,
			rowsWritten: 9
		});
	} finally {
		vi.unstubAllGlobals();
	}
});

test('credentials prefers the selected account, then the Free plan one, and never mixes them', () => {
	const free = { FREE_CLOUDFLARE_ACCOUNT_ID: 'a', FREE_CLOUDFLARE_API_TOKEN: 'b' };
	const selected = { FOLIO_CLOUDFLARE_ACCOUNT_ID: 'c', FOLIO_CLOUDFLARE_API_TOKEN: 'd' };
	expect(credentials(free)).toEqual({ account: 'a', token: 'b', label: 'FREE' });
	expect(credentials({ ...free, ...selected })).toEqual({
		account: 'c',
		token: 'd',
		label: 'SELECTED'
	});
	expect(credentials({ ...free, FOLIO_CLOUDFLARE_ACCOUNT_ID: 'c' }).account).toBe('a');
	expect(() => credentials({})).toThrow(/FOLIO_CLOUDFLARE_ACCOUNT_ID/);
});
