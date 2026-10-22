import { expect, test } from 'vitest';
import {
	boundaryShift,
	flattenPeriodic,
	gbPerActiveSecond,
	parseDeployLog,
	summarizeConfig,
	summarizeMeter,
	summarizeSteps,
	tailCalls
} from '../../experiments/bootimage/analyze.ts';
import { checkPages, pageBytes, pagesChecksum } from '../../experiments/bootimage/checksum.ts';
import { settlePeriodic } from '../../experiments/bootimage/periodic.ts';
import {
	boundaryName,
	driveMemory,
	emptyMiB,
	memoryBound,
	memoryConfigs,
	meterName,
	requestBound,
	sequence,
	type Fetched
} from '../../experiments/bootimage/plan.ts';
import { importModule, ownModule } from '../../experiments/bootimage/prepare.ts';

test('checksum covers every check page and its position', () => {
	const pages = Math.max(...checkPages) + 1;
	const base = new ArrayBuffer(pages * pageBytes);
	const same = pagesChecksum(base);
	expect(pagesChecksum(new ArrayBuffer(pages * pageBytes))).toBe(same);
	for (const page of checkPages) {
		const copy = new Uint8Array(new ArrayBuffer(pages * pageBytes));
		copy[page * pageBytes + pageBytes - 1] = 1;
		expect(pagesChecksum(copy.buffer)).not.toBe(same);
	}
	const untouched = new Uint8Array(new ArrayBuffer(pages * pageBytes));
	untouched[1 * pageBytes] = 1;
	expect(pagesChecksum(untouched.buffer)).toBe(same);
});

test('each variant sends 21 uniquely indexed Durable Object requests within the bound', () => {
	for (const variant of ['a', 'b', 'c'] as const) {
		const steps = sequence(variant);
		expect(steps).toHaveLength(21);
		expect(new Set(steps.map((step) => step.path)).size).toBe(21);
		expect(steps.filter((step) => step.path.includes('check=1'))).toHaveLength(3);
		const bound = requestBound(variant);
		expect(bound.maximumRequests).toBeLessThanOrEqual(25);
		expect(bound.maximumDurableObjectRequests).toBeLessThanOrEqual(25);
	}
	const memory = sequence('a').filter((step) => step.path.startsWith('/memory'));
	expect(memory).toHaveLength(emptyMiB.length * 4);
	expect(sequence('b').every((step) => step.path.startsWith('/inst?m=boot'))).toBe(true);
	expect(sequence('c').every((step) => step.path.startsWith('/inst?m=render'))).toBe(true);
});

test('the generated empty-memory modules validate and size their memory', () => {
	expect(WebAssembly.validate(importModule())).toBe(true);
	const memory = new WebAssembly.Memory({ initial: 4, maximum: 65536 });
	new WebAssembly.Instance(new WebAssembly.Module(importModule()), { env: { memory } });
	for (const mib of emptyMiB) {
		const bytes = ownModule(mib * 16);
		expect(WebAssembly.validate(bytes)).toBe(true);
		const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
		expect((instance.exports.memory as WebAssembly.Memory).buffer.byteLength).toBe(
			mib * 1048576
		);
	}
});

test('parseDeployLog reads upload sizes, startup time and refusal lines', () => {
	const ok = parseDeployLog(
		'Total Upload: 13615.18 KiB / gzip: 4187.80 KiB\nWorker Startup Time: 2 ms\nUploaded cfw-folio-x (5 sec)\n'
	);
	expect(ok).toMatchObject({
		uploadKiB: 13615.18,
		gzipKiB: 4187.8,
		startupMs: 2,
		uploaded: true
	});
	expect(ok.refusal).toBeUndefined();
	const refused = parseDeployLog(
		'Total Upload: 1 KiB / gzip: 1 KiB\n\u001b[31m[ERROR]\u001b[0m Your Worker exceeded the size limit of 3 MiB\n'
	);
	expect(refused.startupMs).toBeNull();
	expect(refused.refusal?.[0]).toContain('exceeded the size limit');
});

const event = (entrypoint: string | undefined, path: string, outcome: string, cpu: number) =>
	JSON.stringify(
		{
			cpuTime: cpu,
			wallTime: 0,
			outcome,
			...(entrypoint ? { entrypoint } : {}),
			event: { request: { url: `https://x.invalid${path}` } },
			exceptions: outcome === 'ok' ? [] : [{ message: 'Worker exceeded memory limit.' }]
		},
		null,
		4
	);

test('summarizeSteps joins steps to Durable Object invocations and checks the image', () => {
	const steps = sequence('b').slice(0, 3);
	const body = (checksum?: number) =>
		JSON.stringify({
			memoryBytes: 67108864,
			moduleTag: 'ab',
			moduleCalls: 1,
			objectCalls: 1,
			checksum
		});
	const tail = [
		event(undefined, steps[0]!.path, 'ok', 0),
		event('BootImage', steps[0]!.path, 'ok', 9),
		event('BootImage', steps[1]!.path, 'ok', 7),
		event('BootImage', steps[2]!.path, 'exceededMemory', 0)
	].join('\n');
	const summary = summarizeSteps({
		variant: 'b',
		steps: [
			{ ...steps[0], status: 200, wallMs: 5, body: body(111) },
			{ ...steps[1], status: 200, wallMs: 5, body: body() },
			{ ...steps[2], status: 502, wallMs: 5, body: '{"error":"x"}' }
		],
		tail,
		expected: { boot: { checksum: 111, memoryBytes: 67108864 } }
	});
	expect(summary.rows.map((row) => row.cpuMs)).toEqual([9, 7, 0]);
	expect(summary.checksums).toEqual({ expected: 111, checked: 1, matching: 1 });
	expect(summary.refused).toEqual([
		{
			label: steps[2]!.label,
			outcome: 'exceededMemory',
			error: 'Worker exceeded memory limit.'
		}
	]);
	expect(summary.groups['boot-fresh']?.cpuMs).toMatchObject({ n: 2, max: 7 });
});

const mebibyte = 1048576;

/** A fake Durable Object per name: held memory, 8 MiB per step, reset (new tag, nothing held) at a limit. */
function fakePlatform(limitMiB: (obj: string) => number) {
	const objects: Record<string, { tag: string; calls: number; held?: number; ballast: number }> =
		{};
	let isolates = 0;
	return async (path: string): Promise<Fetched> => {
		const url = new URL(`https://x${path}`);
		const obj = url.searchParams.get('obj')!;
		const state = (objects[obj] ??= { tag: `t${isolates++}`, calls: 0, ballast: 0 });
		state.calls++;
		const tags = { moduleTag: state.tag, moduleCalls: state.calls, objectCalls: state.calls };
		if (url.pathname === '/inst') {
			const memoryBytes = Number(url.searchParams.get('pages')) * 65536;
			if (url.searchParams.get('keep') === '1') {
				state.held = memoryBytes;
				state.ballast = 0;
			}
			return { status: 200, wallMs: 1, body: JSON.stringify({ ...tags, memoryBytes }) };
		}
		if (!state.held)
			return { status: 409, wallMs: 1, body: JSON.stringify({ ...tags, held: false }) };
		state.ballast += Number(url.searchParams.get('mib')) * mebibyte;
		if ((state.held + state.ballast) / mebibyte > limitMiB(obj)) {
			state.held = undefined;
			state.tag = `t${isolates++}`;
			return {
				status: 502,
				wallMs: 1,
				body: JSON.stringify({
					error: "Durable Object's isolate exceeded its memory limit and was reset."
				})
			};
		}
		return {
			status: 200,
			wallMs: 1,
			body: JSON.stringify({
				...tags,
				held: true,
				ballastBytes: state.ballast,
				memoryBytes: state.held,
				liveBytes: state.held + state.ballast
			})
		};
	};
}

test('the memory sequence stops an object at its reset and stays within the bound', async () => {
	for (const variant of ['a', 'c'] as const) {
		const steps = await driveMemory(
			variant,
			fakePlatform(() => 200)
		);
		expect(steps.length).toBeLessThanOrEqual(memoryBound(variant).maximumDurableObjectRequests);
		expect(new Set(steps.map((step) => step.path)).size).toBe(steps.length);
		const keeps = steps.filter((step) => String(step.group).endsWith('-keep'));
		expect(keeps).toHaveLength(memoryConfigs[variant].length * 3);
		const meter = steps.filter((step) => String(step.group).endsWith('-meter'));
		expect(meter).toHaveLength(memoryConfigs[variant].length * 12);
		expect(steps.filter((step) => String(step.group).endsWith('-after'))).toHaveLength(
			keeps.length
		);
	}
	expect(memoryBound('a').maximumDurableObjectRequests).toBe(2 * 3 * 41 + 2 * 12);
	expect(memoryBound('c').maximumDurableObjectRequests).toBe(3 * 41 + 12);
});

test('an object that never resets stops at the step cap without an after request', async () => {
	const steps = await driveMemory(
		'c',
		fakePlatform(() => 1e9),
		() => {},
		5
	);
	const first = steps.filter((step) => String(step.path).includes('obj=bal-c86-0&'));
	expect(first.map((step) => step.group)).toEqual(['c86-keep', ...Array(5).fill('c86-ballast')]);
});

test('boundary rows report the largest live total, the reset and the new module', async () => {
	const limits: Record<string, number> = { 'bal-a64-0': 200, 'bal-a64-1': 208, 'bal-a64-2': 200 };
	const steps = await driveMemory(
		'a',
		fakePlatform((obj) => limits[obj] ?? 210)
	);
	const tail = [
		JSON.stringify(
			{
				cpuTime: 0,
				outcome: 'exceededMemory',
				entrypoint: 'BootImage',
				event: {
					request: {
						url: `https://probe${steps.find((step) => String(step.path).includes('obj=bal-a64-0') && step.status === 502)!.path}`
					}
				},
				exceptions: [
					{ message: 'Durable Object isolate exceeded its memory limit and was reset.' }
				]
			},
			null,
			4
		)
	].join('\n');
	const config = summarizeConfig(memoryConfigs.a[0]!, steps, tail, 3);
	expect(config.objects[0]!.reset).toMatchObject({
		status: 502,
		outcome: 'exceededMemory',
		afterStatus: 409,
		afterHeld: false,
		afterTagChanged: true
	});
	expect(config.liveMiB).toEqual({ n: 3, median: 200, min: 200, max: 208 });
	expect(config.ballastMiB).toEqual({ n: 3, median: 136, min: 136, max: 144 });
	expect(config.capped).toBe(0);
	const wide = summarizeConfig(memoryConfigs.a[1]!, steps, '', 3);
	expect(wide.ballastMiB.median).toBe(120);
	expect(boundaryShift(config, wide, 22.6)).toEqual({ shiftMiB: 16, memoryDeltaMiB: 22.6 });
});

test('an object that shares a module with an earlier one is left out of the range', () => {
	const keep = (calls: number) =>
		JSON.stringify({ moduleTag: 'x', moduleCalls: calls, objectCalls: 1, memoryBytes: 1 });
	const row = (obj: string, calls: number, live: number) => [
		{ group: 'a64-keep', path: `/inst?obj=${obj}&i=0`, status: 200, body: keep(calls) },
		{
			group: 'a64-ballast',
			path: `/ballast?obj=${obj}&i=1`,
			status: 200,
			body: JSON.stringify({ held: true, liveBytes: live, ballastBytes: live })
		}
	];
	const steps = [
		...row(boundaryName(memoryConfigs.a[0]!, 0), 1, 8 * mebibyte),
		...row(boundaryName(memoryConfigs.a[0]!, 1), 9, 99 * mebibyte)
	];
	const config = summarizeConfig(memoryConfigs.a[0]!, steps, '', 2);
	expect(config.discarded).toBe(1);
	expect(config.liveAllMiB).toMatchObject({ n: 2, min: 8, max: 99 });
	expect(config.liveMiB).toEqual({ n: 1, median: 8, min: 8, max: 8 });
});

test('the meter rows give GB-s per active second and per request, by configuration', () => {
	const group = (name: string, duration: number, activeTime: number, cpuTime: number) => ({
		dimensions: { objectId: name, name },
		sum: { duration, activeTime, cpuTime, exceededMemoryErrors: 0, rowsRead: 0, rowsWritten: 0 }
	});
	const config = memoryConfigs.a[0]!;
	const rows = flattenPeriodic({
		data: {
			viewer: {
				accounts: [
					{
						durableObjectsPeriodicGroups: [
							group(meterName(config, 0), 1.28, 10e6, 4000),
							group(meterName(config, 1), 1.28, 10e6, 5000),
							group('other', 5, 1e6, 1)
						]
					}
				]
			}
		}
	});
	expect(gbPerActiveSecond(rows[0]!)).toBeCloseTo(0.128);
	const meter = summarizeMeter(config, rows);
	expect(meter.objectsFound).toBe(2);
	expect(meter.requests).toBe(8);
	expect(meter.gbPerActiveSecond).toBeCloseTo(0.128);
	expect(meter.durationPerRequestGbS).toBeCloseTo(0.32);
	expect(meter.cpuMsPerRequest).toBeCloseTo(1.125);
	expect(flattenPeriodic({})).toEqual([]);
});

test('settlePeriodic waits for every name and two equal reads, and gives up at the maximum', async () => {
	const body = (names: string[]) => ({
		data: {
			viewer: {
				accounts: [
					{
						durableObjectsPeriodicGroups: names.map((name) => ({
							dimensions: { objectId: name, name },
							sum: { duration: 1, activeTime: 1, cpuTime: 1, exceededMemoryErrors: 0 }
						}))
					}
				]
			}
		}
	});
	const waits: number[] = [];
	const settle = {
		firstWaitMs: 10,
		pollMs: 1,
		maximumMs: 14,
		sleep: async (ms: number) => void waits.push(ms)
	};
	const replies = [body(['a']), body(['a', 'b']), body(['a', 'b']), body(['a', 'b'])];
	const done = await settlePeriodic(
		async () => replies.shift(),
		['a', 'b'],
		0,
		() => {},
		settle
	);
	expect(done).toMatchObject({ complete: true, polls: 3 });
	expect(waits).toEqual([10, 1, 1]);
	const never = await settlePeriodic(
		async () => body(['a']),
		['a', 'b'],
		0,
		() => {},
		settle
	);
	expect(never).toMatchObject({ complete: false });
});

test('a tail file that holds a connection error gives no invocations', () => {
	expect(tailCalls("AggregateError [ETIMEDOUT]: {\n  code: 'ETIMEDOUT',\n}\n")).toEqual([]);
});
