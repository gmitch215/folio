import { expect, test } from 'vitest';
import {
	decide,
	deployed,
	referenceHashes,
	scriptLimitBytes,
	summarizeAnatomy,
	summarizeArms,
	summarizeBundle,
	summarizeDelivery,
	summarizeInterpreter,
	summarizePhases,
	summarizeReplay,
	summarizeRetain,
	summarizeWorkerd,
	withDerived
} from '../../scripts/analyze/bootimage.ts';

const phase = (position: string, scale: number, sha = 'abc') => ({
	kind: 'phases',
	position,
	factoryMs: 40 * scale,
	bootMs: 200 * scale,
	mountsMs: 100 * scale,
	shimsMs: 20 * scale,
	kernelMs: 80 * scale,
	firstRenderMs: 700 * scale,
	secondRenderMs: 50 * scale,
	firstSha256: sha,
	secondSha256: sha
});

test('derived boot figures separate what an image replaces from what stays', () => {
	const row = withDerived(phase('first', 1));
	expect(row.bootTotalMs).toBe(240);
	expect(row.replaceableMs).toBe(140);
	expect(row.bootToFirstRenderMs).toBe(940);
	expect(row.replaceableToFirstRenderMs).toBe(840);
});

test('phase medians keep n with min and max, per position, and count render hashes', () => {
	const rows = [1, 2, 3, 4, 5]
		.map((i) => phase('second', i))
		.concat([phase('first', 2, 'other')]);
	const summary = summarizePhases(rows);
	expect(summary.positions.second!.n).toBe(5);
	expect(summary.positions.second!.fields.kernelMs).toEqual({
		n: 5,
		median: 240,
		min: 80,
		max: 400
	});
	expect(summary.positions.first!.n).toBe(1);
	expect(summary.distinctRenderHashes).toBe(2);
});

const anatomyRow = (round: number, deltaPages: number) => ({
	kind: 'anatomy',
	round,
	image: 'boot',
	memoryBytes: 1024 * 65536,
	pages: 1024,
	nonzeroPages: 174,
	nonzeroBytes: 174 * 65536,
	freshNonzeroPages: 65,
	deltaPages,
	deltaBytes: deltaPages * 65536,
	deltaZeroedByBootPages: 0,
	globals: [10, 0],
	freshGlobals: [10, 1],
	table: { tableUnchanged: true },
	nonzero: { chunkStoredBytes: 100, chunkDeflateMs: 3 },
	delta: { chunkStoredBytes: 60, chunkDeflateMs: 2 }
});

test('anatomy flags rounds that disagree and counts globals that boot changed', () => {
	const same = summarizeAnatomy([anatomyRow(0, 111), anatomyRow(1, 111)]);
	expect(same.images.boot.pageCountsIdenticalAcrossRounds).toBe(true);
	expect(same.images.boot.globalsChanged).toBe(1);
	const drift = summarizeAnatomy([anatomyRow(0, 111), anatomyRow(1, 112)]);
	expect(drift.images.boot.pageCountsIdenticalAcrossRounds).toBe(false);
});

const deliverRow = (rep: number, ms: number, baseMs = 0, verified?: boolean) => ({
	kind: 'deliver',
	image: 'boot',
	shape: 'delta',
	variant: 'sql-deflated-200k',
	imageBytes: 100,
	storedBytes: 40,
	rows: 4,
	rep,
	ms,
	baseMs,
	verified
});

test('delivery totals add the base instance and report the first rep alone', () => {
	const rows: any[] = [
		deliverRow(0, 90, 5, true),
		deliverRow(1, 50, 4),
		deliverRow(2, 40, 4),
		deliverRow(3, 60, 4)
	];
	const summary = summarizeDelivery(rows);
	const route = summary.route['boot/delta/sql-deflated-200k']!;
	expect(route.totalMs.first).toBe(95);
	expect(route.totalMs.median).toBe(64);
	expect(route.totalMs.withoutFirst.median).toBe(54);
	expect(route.allVerified).toBe(true);
	const bad = summarizeDelivery([deliverRow(0, 1, 0, false)]);
	expect(bad.route['boot/delta/sql-deflated-200k']!.allVerified).toBe(false);
});

test('baked module rows give compile, instance and verification', () => {
	const rows: any[] = [
		{ kind: 'module', variant: 'baked-boot', moduleBytes: 200, memoryBytes: 64 },
		...[0, 1, 2].map((rep) => ({ kind: 'compile', variant: 'baked-boot', rep, ms: 10 + rep })),
		...[0, 1, 2].map((rep) => ({
			kind: 'instance',
			variant: 'baked-boot',
			rep,
			ms: 4 + rep,
			memoryMs: 0.1,
			verified: rep === 0 ? true : undefined
		}))
	];
	const { modules } = summarizeDelivery(rows);
	expect(modules['baked-boot']!.moduleBytes).toBe(200);
	expect(modules['baked-boot']!.compile.median).toBe(11);
	expect(modules['baked-boot']!.instance.first).toBe(4);
	expect(modules['baked-boot']!.allVerified).toBe(true);
});

test('retention is the rss change across compile, instance and drops', () => {
	const sample = (rss: number) => ({ rss, external: 0, arrayBuffers: 0, heapUsed: 0 });
	const row = {
		kind: 'retain',
		variant: 'baked',
		gcAvailable: true,
		afterStart: sample(100),
		afterCompile: sample(130),
		afterInstance: sample(190),
		afterInstanceDropped: sample(140),
		afterModuleDropped: sample(105)
	};
	const out = summarizeRetain([row]);
	expect(out.baked.compileRssBytes.median).toBe(30);
	expect(out.baked.instanceRssBytes.median).toBe(60);
	expect(out.baked.residualRssBytes.median).toBe(5);
});

test('decision ratios divide delivery by each reference, local and deployed', () => {
	const phases = summarizePhases([phase('first', 2), phase('second', 1)]);
	const delivery = summarizeDelivery([
		{ kind: 'module', variant: 'baked-boot', moduleBytes: 1, memoryBytes: 1 },
		{ kind: 'instance', variant: 'baked-boot', rep: 0, ms: 14, memoryMs: 0 },
		deliverRow(0, 70, 0)
	] as any[]);
	const { references, routes } = decide(delivery, phases);
	expect(references.localReplaceableSecond).toBe(140);
	const baked = routes['baked-boot/instance']!;
	expect(baked.ratio.localReplaceableSecond).toBeCloseTo(0.1, 10);
	expect(baked.ratio.deployedKernelBootLow).toBeCloseTo(14 / deployed.kernelBootLow, 10);
	expect(baked.beatsDeployedInterpreterFloor).toBe(true);
	const rows = routes['boot/delta/sql-deflated-200k']!;
	expect(rows.beatsLocalReplaceableSecond).toBe(true);
	expect(rows.deliveryMs).toBe(70);
});

const reference = (seed: string, front: string, pages: [string, string][] = []) => ({
	kind: 'reference',
	seed,
	frontSha256: front,
	frontAgainSha256: front,
	pages: pages.map(([path, sha256]) => ({ path, sha256 }))
});

const renderRow = (path: string, sha256: string, seed = 'A', round = 0, position = 'first') => ({
	kind: 'render',
	image: 'boot',
	variant: 'replay',
	seed,
	round,
	position,
	path,
	ok: true,
	sha256
});

test('replay rows are checked against the booted hash of the same seed and path', () => {
	const refs = referenceHashes([
		reference('', 'front0'),
		reference('A', 'front0', [['/node/2', 'n2']]),
		reference('B', 'frontB', [['/node/2', 'nB']])
	] as any[]);
	expect(refs.none!['/']).toEqual(['front0']);
	const rows: any[] = [
		renderRow('/', 'front0'),
		renderRow('/node/2', 'n2'),
		renderRow('/node/2', 'wrong', 'A', 1),
		renderRow('/', 'front0', 'B')
	];
	const summary = summarizeReplay(rows, refs);
	const a = summary['boot/replay/A/first']!;
	expect(a.perPath['/']).toMatchObject({ n: 1, matches: 1 });
	expect(a.perPath['/node/2']).toMatchObject({ n: 2, matches: 1, distinctHashes: 2 });
	expect(summary['boot/replay/B/first']!.perPath['/']!.matches).toBe(0);
});

test('a failed render row keeps its stage and the head of the error', () => {
	const failed = [
		{
			kind: 'render',
			image: 'boot',
			variant: 'plain',
			round: 0,
			ok: false,
			stage: 'render /',
			error: 'TypeError: x'
		}
	];
	const out = summarizeReplay(failed as any[], {});
	expect(out['boot/plain/none/first']).toMatchObject({ failed: 1, failedStage: 'render /' });
	expect(out['boot/plain/none/first']!.firstError).toContain('TypeError');
});

test('arm savings are the plain median minus the arm median, per position', () => {
	const arm = (name: string, position: string, totalMs: number) => ({
		kind: 'arm',
		arm: name,
		position,
		totalMs,
		firstSha256: 'x',
		secondSha256: 'x'
	});
	const { arms, saving } = summarizeArms([
		arm('plain', 'first', 1000),
		arm('plain', 'first', 1200),
		arm('boot', 'first', 700),
		arm('render', 'first', 400),
		arm('plain', 'second', 800),
		arm('render', 'second', 300)
	] as any[]);
	expect(arms['plain/first']!.n).toBe(2);
	expect(saving['boot/first']).toMatchObject({ plainMs: 1200, armMs: 700, savedMs: 500 });
	expect(saving['render/second']!.ratio).toBeCloseTo(0.375, 10);
	expect(saving['boot/second']).toBeUndefined();
});

test('workerd rows subtract the no-op request and report rss growth in bytes', () => {
	const row = (rep: number) => ({
		kind: 'workerd',
		ok: true,
		variant: 'baked-boot',
		operation: '/instantiate',
		rep,
		startMs: 300,
		noopMs: [1, 1, 1],
		firstMs: 11,
		firstInnerMs: 0,
		warmMs: [6, 7],
		manyMs: 51,
		manyCount: 10,
		rssKb: {
			start: 100,
			afterFirst: 110,
			afterMany: 120,
			held3: 400,
			touched3: 500,
			dropped: 130
		}
	});
	const out = summarizeWorkerd([
		{
			kind: 'wmodule',
			variant: 'baked-boot',
			moduleBytes: 9,
			gzipBytes: 3,
			pages: 1,
			valid: true
		},
		row(0),
		row(1)
	] as any[]);
	const v = out.variants['baked-boot']!;
	expect(v.coldMs.median).toBe(10);
	expect(v.warmMs.n).toBe(4);
	expect(v.manyPerInstanceMs.median).toBe(5);
	expect(v.rssGrowthBytes.held3.median).toBe(300 * 1024);
	expect(out.modules['baked-boot']!.gzipBytes).toBe(3);
});

test('interpreter summary lists the digests, the PHP versions and any run that changed', () => {
	const at = (sha: string) => ({ wasmSha256: sha, glueSha256: 'g' });
	const out = summarizeInterpreter({
		arms: [
			{ kind: 'arm', interp: at('a') },
			{ kind: 'arm', interp: at('a') }
		] as any[],
		anatomy: [
			{ kind: 'php', version: '8.5.2', interp: at('a') },
			{ kind: 'interpCheck', same: true, interp: at('a') },
			{ kind: 'interpCheck', same: false, interp: at('a') }
		] as any[],
		bare: [{ kind: 'environment' }] as any[]
	});
	expect(out.wasmSha256).toEqual(['a']);
	expect(out.phpVersions).toEqual(['8.5.2']);
	expect(out.rowsWithout).toBe(1);
	expect(out.runsChecked).toBe(2);
	expect(out.allUnchanged).toBe(false);
});

test('bundle summary gives growth over the plain module and headroom under the script limit', () => {
	expect(scriptLimitBytes).toBe(67004006);
	const [boot, render] = summarizeBundle([
		{ name: 'boot', moduleBytes: 21_000_000, originalBytes: 14_000_000, deltaBytes: 7_012_352 },
		{
			name: 'render',
			moduleBytes: 64_500_000,
			originalBytes: 14_000_000,
			deltaBytes: 50_528_256
		}
	]);
	expect(boot).toMatchObject({ growthBytes: 7_000_000, deltaPages: 107, deltaMiB: 6.69 });
	expect(render).toMatchObject({
		growthBytes: 50_500_000,
		deltaPages: 771,
		deltaMiB: 48.19,
		headroomBytes: 2_504_006,
		plainHeadroomBytes: 53_004_006
	});
});

test('bundle summary sets the module plus the rest of the bundle against the limit', () => {
	const [render] = summarizeBundle(
		[
			{
				name: 'render',
				moduleBytes: 64_500_000,
				originalBytes: 14_000_000,
				deltaBytes: 50_500_000
			}
		],
		{ kind: 'bundle', nonModuleKiB: 3_800 }
	);
	expect(render!.bundleKiB).toBeCloseTo(66_788.3, 1);
	expect(render!.limitKiB).toBeCloseTo(65_433.6, 1);
	expect(render!.overLimitKiB).toBeCloseTo(1_354.7, 1);
	expect(
		summarizeBundle([{ name: 'x', moduleBytes: 1, originalBytes: 1, deltaBytes: 0 }])[0]
	).not.toHaveProperty('overLimitKiB');
});
