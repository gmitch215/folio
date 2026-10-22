import { deflateRawSync } from 'node:zlib';
import { expect, test } from 'vitest';
import {
	bodyHash,
	cpuByTag,
	median,
	normalizeBody,
	outcomes,
	pairedCpu,
	saving,
	summarizeArm,
	withinBudget,
	type StepRow
} from '../../experiments/bootimage/s34-analyze.ts';
import {
	bakedSource,
	differingPages,
	joinRows,
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
		event(undefined, '/s34body?site=a&path=/&tag=t1', 3),
		event('SitePhpDurableObject', '/__s34body?site=a&path=/&tag=t1', 1100),
		event('SitePhpDurableObject', '/__s34body?site=b&path=/&tag=t2', 400, 'exceededMemory')
	].join('\n');
	const joined = cpuByTag(tail, ['t1', 't2', 't3']);
	const prefixed = cpuByTag(
		[tail, event('SitePhpDurableObject', '/__s34probe?tag=t1csrf', 9)].join('\n'),
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
				tails.push(event('Obj', `/__s34body?tag=${tag}`, cpu));
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
