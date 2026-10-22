import { expect, test } from 'vitest';
import { summarizeSite } from '../../scripts/analyze/siteconc.ts';
import {
	arms,
	batchSize,
	drainQueue,
	parsePs,
	psTimeMs,
	staticShares
} from '../../scripts/probe/site-concurrency.ts';

test('staticShares deals item i to share i mod n', () => {
	const shares = staticShares([...Array(batchSize).keys()], 8);
	expect(shares.map((s) => s.length)).toEqual([4, 4, 4, 4, 4, 4, 4, 3]);
	expect(shares[3]).toEqual([3, 11, 19, 27]);
	expect(shares.flat().sort((a, b) => a - b)).toEqual([...Array(batchSize).keys()]);
});

test('ps time and rows parse', () => {
	expect(psTimeMs('0:01.37')).toBe(1370);
	expect(psTimeMs('12:03.50')).toBe(723500);
	expect(psTimeMs('1:02:03.00')).toBe(3723000);
	expect(() => psTimeMs('n/a')).toThrow(/unreadable/);
	const rows = parsePs('  101  443152   0:02.50\n  102   87104   0:00.10\n');
	expect(rows.get(101)).toEqual({ rssKb: 443152, cpuMs: 2500 });
	expect(rows.get(102)).toEqual({ rssKb: 87104, cpuMs: 100 });
});

test('drainQueue runs every item once and never exceeds its width', async () => {
	let live = 0;
	let peak = 0;
	const seen: string[] = [];
	await drainQueue(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3, async (item) => {
		peak = Math.max(peak, ++live);
		await new Promise((r) => setTimeout(r, 2));
		seen.push(item);
		live--;
	});
	expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
	expect(peak).toBe(3);
});

test('arms hold one process for queue arms and c processes for static arms', () => {
	for (const arm of arms) {
		if (arm.kind === 'queue') expect(arm.hosts).toBe(1);
		if (arm.kind === 'static') expect(arm.hosts).toBe(arm.c);
		if (arm.kind === 'spin') expect(arm.hosts).toBe(0);
	}
});

const host = (workerdCpuMs: number) => ({
	workerdCpuMs,
	bunCpuMs: 10,
	workerdRssKb: 400 * 1024,
	bunRssKb: 90 * 1024
});

const sample = (
	run: number,
	round: number,
	arm: string,
	armKind: string,
	c: number,
	hosts: number,
	wallMs: number,
	cpu: number
) => ({
	kind: 'sample',
	run,
	round,
	arm,
	armKind,
	c,
	hosts,
	requests: 4,
	wallMs,
	ms: armKind === 'spin' ? [] : [wallMs / 4, wallMs / 4, wallMs / 4, wallMs / 4],
	spinMs: armKind === 'spin' ? [wallMs / 4, wallMs / 4, wallMs / 4, wallMs / 4] : [],
	status: armKind === 'spin' ? [] : [200, 200, 200, 200],
	cache: armKind === 'spin' ? [] : ['RENDER', 'RENDER', 'RENDER', 'RENDER'],
	gateAhead: armKind === 'spin' ? [] : [0, 1, 2, 3],
	workerMs: [],
	perHostRequests: Array(hosts).fill(4 / Math.max(hosts, 1)),
	perHost: Array.from({ length: hosts }, () => host(cpu / hosts)),
	clientCpuMs: wallMs * c,
	load: [4, 3, 2]
});

const run = [
	{ kind: 'environment', machine: 'synthetic' },
	{
		kind: 'boot',
		host: 0,
		readyMs: 3000,
		warmMs: [1400, 90, 60],
		warmCache: ['RENDER', 'RENDER', 'RENDER'],
		warmStatus: [200, 200, 200],
		workerdRssKb: 400 * 1024,
		bunRssKb: 90 * 1024
	},
	sample(0, 0, 'queue-c1', 'queue', 1, 1, 400, 380),
	sample(0, 0, 'queue-c2', 'queue', 2, 1, 405, 385),
	sample(0, 0, 'queue-c4', 'queue', 4, 1, 410, 390),
	sample(0, 0, 'static-2', 'static', 2, 2, 210, 400),
	sample(0, 0, 'spin-c1', 'spin', 1, 0, 400, 400),
	sample(0, 0, 'spin-c4', 'spin', 4, 0, 110, 440),
	{ kind: 'hostLog', errors: { 'rust failure': 3 } }
];

test('summarizeSite pairs every arm with the one-process serial arm of its round', () => {
	const summary = summarizeSite([run]);
	const arm = summary.arms as Record<string, any>;
	expect(arm['queue-c1'].speedupOverC1.median).toBe(1);
	expect(arm['queue-c4'].speedupOverC1.median).toBeCloseTo(400 / 410);
	expect(arm['static-2'].speedupOverC1.median).toBeCloseTo(400 / 210);
	expect(arm['static-2'].speedupOverQueueSameC.median).toBeCloseTo(405 / 210);
	expect(arm['queue-c4'].speedupOverQueueSameC).toBeUndefined();
	expect(arm['static-2'].cpuOverC1.median).toBeCloseTo((400 + 20) / (380 + 10));
	expect(arm['spin-c4'].speedupOverC1.median).toBeCloseTo(400 / 110);
	expect(arm['queue-c4'].gateAheadMax).toBe(3);
	expect(arm['queue-c4'].notRender).toBe(0);
	expect(arm['queue-c1'].workerdRssMb.median).toBe(400);
	expect(summary.batch.map((b) => b.arm)).toEqual(['one process, serial', '2 processes']);
	expect(summary.hostErrors).toEqual([{ 'rust failure': 3 }]);
});

test('summarizeSite counts a request that was not a full render or not a 200', () => {
	const bad = {
		...sample(0, 1, 'queue-c1', 'queue', 1, 1, 400, 380),
		cache: ['HIT', 'RENDER', 'RENDER', 'RENDER'],
		status: [200, 503, 200, 200]
	};
	const summary = summarizeSite([[...run, bad]]);
	const one = (summary.arms as Record<string, any>)['queue-c1'];
	expect(one.notRender).toBe(1);
	expect(one.notOk).toBe(1);
	expect(one.n).toBe(2);
});

test('summarizeSite refuses an empty input', () => {
	expect(() => summarizeSite([[{ kind: 'environment' }]])).toThrow(/no samples/);
});

test('summarizeSite carries the private-context regeneration arms beside the site arms', () => {
	const folio = [
		{ kind: 'environment', machine: 'synthetic', boots: [] },
		{ kind: 'warmup', firstRenderMs: [100, 120] },
		{
			kind: 'oracle',
			perUrl: [
				{ url: '/', ms: 300, bytes: 1 },
				{ url: '/node/1', ms: 50, bytes: 1 }
			]
		},
		...[
			['serial', 1, 400, 400],
			['regen-2', 2, 200, 410]
		].map(([arm, width, wallMs, cpu]) => ({
			kind: 'sample',
			round: 0,
			arm,
			width,
			pages: 2,
			wallMs,
			busyMs: [wallMs],
			pagesPerWorker: [2],
			processCpuMs: cpu,
			load: [1, 0, 0]
		}))
	];
	const summary = summarizeSite([run], folio);
	expect(summary.folioRegen?.arms['regen-2']?.speedupOverSerial.median).toBe(2);
	expect(summary.folioRegen?.arms['regen-2']?.processCpuOverSerial.median).toBeCloseTo(1.025);
});
