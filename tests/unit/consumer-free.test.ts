import { expect, test } from 'vitest';
import { spread, summarizeConsumer } from '../../experiments/consumer/analyze.ts';
import { consumers } from '../../experiments/consumer/cases.ts';
import {
	fastHash,
	measureConsumer,
	type Arm,
	type Row
} from '../../experiments/consumer/measure.ts';
import {
	expectedChain,
	invocations,
	parseTail,
	plateauReached
} from '../../experiments/consumer/php/analyze.ts';
import {
	browserMinutesUsed,
	bundleFit,
	bundleLimitBytes,
	parseRequest,
	requestBound
} from '../../experiments/consumer/plan.ts';
import { snapshot } from '../../experiments/lib/cloudflare.ts';

const memoryArm = (name: string, bytes: number, mutate: (view: Uint8Array) => void): Arm => {
	const memory = { buffer: new ArrayBuffer(bytes) } as unknown as WebAssembly.Memory;
	return {
		name,
		api: { exports: {}, memory },
		async run() {
			mutate(new Uint8Array(memory.buffer));
			return { values: [undefined], report: { workers: 0, regions: 1, mode: 'serial' } };
		}
	};
};

test('fastHash covers every byte and its position', () => {
	const a = new Uint8Array(4099);
	const same = fastHash(a);
	expect(fastHash(new Uint8Array(4099))).toBe(same);
	for (const index of [0, 4095, 4096, 4098]) {
		const b = new Uint8Array(4099);
		b[index] = 1;
		expect(fastHash(b)).not.toBe(same);
	}
	const left = new Uint8Array(8);
	const right = new Uint8Array(8);
	left.set([1, 0, 0, 0, 2, 0, 0, 0]);
	right.set([2, 0, 0, 0, 1, 0, 0, 0]);
	expect(fastHash(left)).not.toBe(fastHash(right));
	expect(fastHash(new Uint8Array(8))).not.toBe(fastHash(new Uint8Array(12)));
});

test('measureConsumer pairs rotated arms and stops on a differing memory', async () => {
	const rows: Row[] = [];
	const spec = {
		name: 'fake',
		cases: [{ name: 'fill', prepare: () => [{ export: 'fill', args: [] }] }]
	};
	const order: string[] = [];
	const fill = (name: string) => (view: Uint8Array) => {
		order.push(name);
		view.fill(7);
	};
	const arms = [
		memoryArm('native', 64, fill('native')),
		memoryArm('folio-2', 64, fill('folio-2'))
	];
	const outcome = await measureConsumer(
		spec,
		arms,
		{ pairs: 4, warmup: 1, budgetMs: 1e9 },
		(row) => rows.push(row)
	);
	expect(outcome.truncated).toBe(false);
	expect(rows.filter((row) => row.kind === 'sample')).toHaveLength(8);
	expect(order.slice(0, 4)).toEqual(['native', 'folio-2', 'folio-2', 'native']);
	await expect(
		measureConsumer(
			spec,
			[memoryArm('native', 64, fill('x')), memoryArm('folio-2', 64, (view) => view.fill(8))],
			{ pairs: 2, warmup: 0, budgetMs: 1e9 },
			(row) => rows.push(row)
		)
	).rejects.toThrow('differ');
	expect(rows.at(-1)).toMatchObject({ kind: 'mismatch', round: 0 });
});

test('measureConsumer reports the pairs completed when the budget ends a run', async () => {
	let clock = 0;
	const rows: Row[] = [];
	const spec = {
		name: 'fake',
		cases: ['a', 'b'].map((name) => ({ name, prepare: () => [] }))
	};
	const arms = [memoryArm('native', 8, () => (clock += 100))];
	const outcome = await measureConsumer(
		spec,
		arms,
		{ pairs: 3, warmup: 0, budgetMs: 250, now: () => clock },
		(row) => rows.push(row)
	);
	expect(outcome).toEqual({ truncated: true, completed: { a: 3 } });
	expect(rows.at(-1)).toMatchObject({ kind: 'done', truncated: true });
});

test('the consumer specs name the exports and cases the consumers run', () => {
	expect(Object.keys(consumers)).toEqual(['kernel-control', 'process-abi', 'tinyimg']);
	expect(consumers.tinyimg!.spec.cases).toHaveLength(13);
	expect(consumers['process-abi']!.spec.cases.map((item) => item.name)).toEqual([
		'memset-16mib',
		'memcpy-16mib',
		'memset-memcpy-chain'
	]);
	const api = { exports: {}, memory: { buffer: new ArrayBuffer(1 << 20) } } as never;
	expect(consumers['kernel-control']!.spec.cases[0]!.prepare(api)).toEqual([
		{ export: 'program', args: [65536, 67, 524288] }
	]);
});

test('request parsing bounds the session and rejects odd consumer names', () => {
	expect(parseRequest(new URLSearchParams('consumer=tinyimg'))).toEqual({
		consumer: 'tinyimg',
		pairs: 20,
		warmup: 2,
		budgetMs: 35000
	});
	expect(
		parseRequest(new URLSearchParams('consumer=a-b&pairs=30&cases=x,y&budget=10'))
	).toMatchObject({
		pairs: 30,
		cases: ['x', 'y'],
		budgetMs: 10000
	});
	for (const bad of [
		'',
		'consumer=../x',
		'consumer=ab&pairs=0',
		'consumer=ab&pairs=101',
		'consumer=ab&budget=99'
	])
		expect(() => parseRequest(new URLSearchParams(bad))).toThrow();
});

test('browser minutes count from 00:00 UTC and treat an open session as running', () => {
	const midnight = 1_760_918_400_000;
	const now = midnight + 3_600_000;
	expect(
		browserMinutesUsed(
			[
				{ startTime: midnight - 60_000, endTime: midnight + 60_000 },
				{ startTime: now - 120_000, endTime: now - 60_000 },
				{ startTime: now - 30_000 }
			],
			now
		)
	).toBeCloseTo(1 + 1 + 0.5);
});

test('bundle arithmetic and request bounds use the 64 MiB limit and the daily quota', () => {
	expect(bundleLimitBytes).toBe(67_108_864);
	const fit = bundleFit({
		original: 13_401_751,
		coordinator: 31_232_047,
		lane: 4_837_570,
		tracked: 8_540_770
	});
	expect(fit.totalBytes).toBe(58_012_138);
	expect(fit.totalMiB).toBeCloseTo(55.3, 1);
	expect(fit.fits).toBe(true);
	expect(bundleFit({ big: 70_000_000 }).fits).toBe(false);
	expect(requestBound({ sessions: 5, probeRequests: 30 })).toEqual({
		workerRequests: 60,
		durableObjectRequests: 5,
		freeDailyQuota: 100_000
	});
});

const session = (
	arm: string,
	name: string,
	round: number,
	wallMs: number,
	digest: string
): Row => ({
	kind: 'sample',
	name,
	arm,
	round,
	wallMs,
	digest,
	passed: true,
	dispatched:
		arm === 'native'
			? undefined
			: { workers: 4, regions: 4, mode: 'native-shared', messages: 4, copiedBytes: 180 }
});

test('the consumer summary pairs by round and refuses a session whose outputs differ', () => {
	const rows: Row[] = [
		{ kind: 'environment', moduleBytes: 10, arenaBytes: {}, loops: [], reasons: [] }
	];
	for (let round = 0; round < 3; round++)
		rows.push(
			session('native', 'k/a', round, 60 + round, 'd'),
			session('folio-4', 'k/a', round, 15, 'd')
		);
	const summary = summarizeConsumer({ passed: true, consumer: 'k', rows });
	const arm: any = (summary.cases['k/a'] as any)['folio-4'];
	expect(arm.pairedSpeedup).toMatchObject({ n: 3, median: 61 / 15, min: 4, max: 62 / 15 });
	expect(arm.dispatch).toMatchObject({
		workers: 4,
		messages: 4,
		copiedBytes: 180,
		modes: 'native-shared'
	});
	expect(summary).toMatchObject({ pairs: 3, exactOutputs: true, cpuMeasured: false });
	rows.push(session('native', 'k/a', 3, 60, 'd'), session('folio-4', 'k/a', 3, 15, 'x'));
	expect(() => summarizeConsumer({ passed: true, consumer: 'k', rows })).toThrow();
	expect(spread([5, 1, 3, 2, 4])).toMatchObject({ n: 5, median: 3, min: 1, max: 5, p95: 5 });
});

test('the account snapshot lists KV, R2 and D1 and records a list the token cannot read as null', async () => {
	const api = async (path: string): Promise<any> => {
		if (path === '/workers/scripts') return [{ id: 'b' }, { id: 'a' }];
		if (path === '/workers/durable_objects/namespaces') return [];
		if (path === '/storage/kv/namespaces') return [{ id: 'k2' }, { id: 'k1' }];
		if (path === '/r2/buckets') return { buckets: [{ name: 'r' }] };
		throw new Error('Authentication error');
	};
	expect(await snapshot(api)).toEqual({
		scripts: ['a', 'b'],
		namespaces: [],
		kv: ['k1', 'k2'],
		r2: ['r'],
		d1: null
	});
});

const tailEvent = (path: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify(
		{
			cpuTime: 84,
			wallTime: 90,
			outcome: 'ok',
			executionModel: 'stateless',
			exceptions: [],
			logs: ['a } brace and "quote" in a log'],
			event: { request: { url: `https://x.example.workers.dev${path}`, method: 'GET' } },
			...extra
		},
		null,
		4
	);

test('the tail parser reads concatenated pretty JSON and drops the account host', () => {
	const text = [
		tailEvent('/worker-boot'),
		tailEvent('/plateau?kind=js&step=8', {
			entrypoint: 'PhpProbe',
			outcome: 'exceededMemory',
			exceptions: [
				{ message: "Durable Object's isolate exceeded its memory limit and was reset." }
			]
		})
	].join('\n');
	const calls = invocations(parseTail(text));
	expect(calls).toHaveLength(2);
	expect(calls[0]).toMatchObject({ entrypoint: 'worker', cpuMs: 84, path: '/worker-boot' });
	expect(calls[1]).toMatchObject({ entrypoint: 'PhpProbe', outcome: 'exceededMemory' });
	expect(calls[1]!.path).toBe('/plateau?kind=js&step=8');
	expect(JSON.stringify(calls)).not.toContain('workers.dev');
});

test('a streamed plateau reports the last step the isolate acknowledged', () => {
	const body =
		'{"kind":"js","addedMiB":8,"linearBytes":1}\n{"kind":"js","addedMiB":16,"linearBytes":2}\n';
	expect(plateauReached(body)).toEqual({ steps: 2, lastAddedMiB: 16, linearBytes: 2 });
});

test('the PHP probe oracle is the SHA-256 chain Node computes', async () => {
	expect(await expectedChain(20000)).toBe(
		'f37804c7509fb1d656c5f2bc2fc18a48cbacd193f733337916e2b0957f8d6c3f'
	);
});
