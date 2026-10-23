import { existsSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, stats, writeSummary, type Row } from './lib.ts';

// boot image summary from boot-image.ts rows: boot phases, image anatomy, delivery cost per
// route, and the ratio of each route to the boot it would replace
// usage: analyzeBootImage('20261022-bootimage'), analyzeBakedBuild('20261022-bootimage-php8512')

// deployed figures from the product's report (edge cpuTime, ms); context for the ratios only
export const deployed = { kernelBootLow: 616, kernelBootHigh: 1036, interpreterFloor: 490 };

const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

const by = <T>(rows: T[], key: (row: T) => string) => {
	const groups = new Map<string, T[]>();
	for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
	return groups;
};

const numbers = (rows: Row[], field: string) =>
	rows.map((row) => row[field]).filter((value): value is number => typeof value === 'number');

const statsOf = (rows: Row[], field: string) => {
	const values = numbers(rows, field);
	return values.length ? stats(values) : undefined;
};

export const phaseFields = [
	'compileMs',
	'seedMs',
	'importMs',
	'memoryMs',
	'instantiateMs',
	'__wasm_call_ctorsMs',
	'runtimeInitMs',
	'pib_storage_initMs',
	'pib_initMs',
	'factoryMs',
	'mountsMs',
	'shimsMs',
	'kernelMs',
	'bootMs',
	'openMs',
	'openCpuMs',
	'firstRenderMs',
	'firstRenderCpuMs',
	'secondRenderMs',
	'secondRenderCpuMs'
];

/** the boot an image replaces: Wasm instance, runtime init, php init, the shims and the kernel */
export const withDerived = (row: Row): Row => ({
	...row,
	bootTotalMs: row.factoryMs + row.bootMs,
	replaceableMs: row.factoryMs + row.shimsMs + row.kernelMs,
	bootToFirstRenderMs: row.factoryMs + row.bootMs + row.firstRenderMs,
	replaceableToFirstRenderMs: row.factoryMs + row.shimsMs + row.kernelMs + row.firstRenderMs
});

export function summarizePhases(rows: Row[]) {
	const phases = rows.filter((row) => row.kind === 'phases').map(withDerived);
	const out: Record<string, any> = {};
	for (const [position, group] of by(phases, (row) => row.position)) {
		const fields: Record<string, any> = {};
		for (const field of [
			...phaseFields,
			'bootTotalMs',
			'replaceableMs',
			'bootToFirstRenderMs',
			'replaceableToFirstRenderMs'
		])
			fields[field] = statsOf(group, field);
		out[position] = { n: group.length, fields };
	}
	const shas = new Set(phases.flatMap((row) => [row.firstSha256, row.secondSha256]));
	return { positions: out, distinctRenderHashes: shas.size, renderHash: [...shas][0] };
}

const sameEverywhere = (rows: Row[], pick: (row: Row) => unknown) =>
	new Set(rows.map((row) => JSON.stringify(pick(row)))).size === 1;

export function summarizeAnatomy(rows: Row[]) {
	const images: Record<string, any> = {};
	for (const [name, group] of by(
		rows.filter((row) => row.kind === 'anatomy'),
		(row) => row.image
	)) {
		const first = group[0]!;
		images[name] = {
			rounds: group.length,
			memoryBytes: first.memoryBytes,
			pages: first.pages,
			nonzeroPages: first.nonzeroPages,
			nonzeroBytes: first.nonzeroBytes,
			freshNonzeroPages: first.freshNonzeroPages,
			deltaPages: first.deltaPages,
			deltaBytes: first.deltaBytes,
			deltaZeroedByBootPages: first.deltaZeroedByBootPages,
			globals: first.globals,
			freshGlobals: first.freshGlobals,
			globalsChanged: first.globals.filter(
				(value: number, i: number) => value !== first.freshGlobals[i]
			).length,
			table: first.table,
			nonzero: first.nonzero,
			delta: first.delta,
			writerParity: group.find((row) => row.writerParity)?.writerParity,
			pageCountsIdenticalAcrossRounds: sameEverywhere(group, (row) => [
				row.memoryBytes,
				row.nonzeroPages,
				row.deltaPages
			]),
			chunkBytesIdenticalAcrossRounds: sameEverywhere(group, (row) => [
				row.nonzero.chunkStoredBytes,
				row.delta.chunkStoredBytes
			]),
			deflateMs: {
				nonzero: statsOf(
					group.map((row) => row.nonzero),
					'chunkDeflateMs'
				),
				delta: statsOf(
					group.map((row) => row.delta),
					'chunkDeflateMs'
				)
			}
		};
	}
	const dirty = rows.filter((row) => row.kind === 'dirty');
	return {
		images,
		dirty: {
			rounds: dirty.length,
			bootToFirstRenderPages: statsOf(dirty, 'bootToFirstRenderPages'),
			firstToSecondRenderPages: statsOf(dirty, 'firstToSecondRenderPages'),
			memoryGrewBytes: statsOf(dirty, 'memoryGrewBytes'),
			fdsAfterBoot: dirty[0]?.fdsAfterBoot,
			fdsAfterRender: dirty[0]?.fdsAfterRender,
			handlesAfterBoot: dirty[0]?.handlesAfterBoot,
			handlesAfterRender: dirty[0]?.handlesAfterRender
		}
	};
}

/** rep 0 runs on cold code; it is kept in n and also reported alone */
const repStats = (rows: Row[], field: string) => {
	const all = statsOf(rows, field);
	const first = rows.find((row) => row.rep === 0)?.[field];
	const rest = statsOf(
		rows.filter((row) => row.rep !== 0),
		field
	);
	return all && { ...all, first, withoutFirst: rest };
};

export function summarizeDelivery(rows: Row[]) {
	const route: Record<string, any> = {};
	const deliver: Row[] = rows
		.filter((row) => row.kind === 'deliver')
		.map((row) => ({ ...row, totalMs: row.ms + row.baseMs }));
	for (const [key, group] of by(deliver, (row) => `${row.image}/${row.shape}/${row.variant}`)) {
		const parts = rows.filter(
			(row) => row.kind === 'component' && `${row.image}/${row.shape}/${row.variant}` === key
		);
		route[key] = {
			n: group.length,
			imageBytes: group[0]!.imageBytes,
			storedBytes: group[0]!.storedBytes,
			rows: group[0]!.rows,
			ms: repStats(group, 'ms'),
			baseInstantiateMs: statsOf(group, 'baseMs'),
			totalMs: repStats(group, 'totalMs'),
			allVerified: group.every((row) => row.verified !== false),
			components: parts.length
				? {
						readMs: statsOf(parts, 'readMs'),
						inflateMs: statsOf(parts, 'inflateMs'),
						digestMs: statsOf(parts, 'digestMs'),
						heapDigestMs: statsOf(parts, 'heapDigestMs')
					}
				: undefined
		};
	}
	const modules: Record<string, any> = {};
	for (const [variant, group] of by(
		rows.filter((row) => row.kind === 'module'),
		(row) => row.variant
	))
		modules[variant] = {
			moduleBytes: group[0]!.moduleBytes,
			memoryBytes: group[0]!.memoryBytes
		};
	for (const kind of ['compile', 'instance']) {
		for (const [variant, group] of by(
			rows.filter((row) => row.kind === kind),
			(row) => row.variant
		)) {
			modules[variant] ??= {};
			modules[variant][kind] = repStats(group, 'ms');
			if (kind === 'instance') {
				modules[variant].memoryCreateMs = statsOf(group, 'memoryMs');
				modules[variant].allVerified = group.every((row) => row.verified !== false);
			}
		}
	}
	return { route, modules };
}

export function summarizeRetain(rows: Row[]) {
	const out: Record<string, any> = {};
	const delta = (row: Row, from: string, to: string, field: string) =>
		row[to][field] - row[from][field];
	for (const [variant, group] of by(
		rows.filter((row) => row.kind === 'retain'),
		(row) => row.variant
	)) {
		const field = (name: string, from: string, to: string) =>
			stats(group.map((row) => delta(row, from, to, name)));
		out[variant] = {
			n: group.length,
			gcAvailable: group.every((row) => row.gcAvailable),
			compileRssBytes: field('rss', 'afterStart', 'afterCompile'),
			compileExternalBytes: field('external', 'afterStart', 'afterCompile'),
			compileArrayBuffersBytes: field('arrayBuffers', 'afterStart', 'afterCompile'),
			instanceRssBytes: field('rss', 'afterCompile', 'afterInstance'),
			droppedInstanceRssBytes: field('rss', 'afterInstance', 'afterInstanceDropped'),
			droppedModuleRssBytes: field('rss', 'afterInstanceDropped', 'afterModuleDropped'),
			residualRssBytes: field('rss', 'afterStart', 'afterModuleDropped')
		};
	}
	return out;
}

/** each route's delivery time as a ratio of the boot it replaces, local and deployed */
export function decide(
	delivery: ReturnType<typeof summarizeDelivery>,
	phases: ReturnType<typeof summarizePhases>
) {
	const local = (position: string, field: string): number | undefined =>
		phases.positions[position]?.fields[field]?.median;
	const references = {
		localReplaceableFirst: local('first', 'replaceableMs'),
		localReplaceableSecond: local('second', 'replaceableMs'),
		localBootToFirstRenderFirst: local('first', 'bootToFirstRenderMs'),
		localBootToFirstRenderSecond: local('second', 'bootToFirstRenderMs'),
		deployedKernelBootLow: deployed.kernelBootLow,
		deployedKernelBootHigh: deployed.kernelBootHigh,
		deployedInterpreterFloor: deployed.interpreterFloor
	};
	const routes: Record<string, any> = {};
	const add = (name: string, ms: number | undefined) => {
		if (ms === undefined) return;
		const ratio: Record<string, number> = {};
		for (const [key, reference] of Object.entries(references))
			if (reference) ratio[key] = ms / reference;
		routes[name] = {
			deliveryMs: ms,
			ratio,
			beatsDeployedInterpreterFloor: ms < deployed.interpreterFloor,
			beatsLocalReplaceableSecond:
				references.localReplaceableSecond !== undefined &&
				ms < references.localReplaceableSecond
		};
	};
	for (const [key, value] of Object.entries(delivery.route)) add(key, value.totalMs?.median);
	for (const [variant, value] of Object.entries(delivery.modules)) {
		if (variant === 'unmodified' || !value.instance) continue;
		add(`${variant}/instance`, value.instance.median);
	}
	return { references, routes };
}

/** one-minute load average at the first and last row of a raw file, with its extremes */
export function loadRange(rows: Row[]) {
	const loads = rows
		.map((row) => row.load?.[0])
		.filter((v): v is number => typeof v === 'number');
	return loads.length
		? { first: loads[0], last: loads.at(-1), min: Math.min(...loads), max: Math.max(...loads) }
		: undefined;
}

// #region baked replay, arms, seed coupling, workerd

/** booted hashes keyed by seed then path; '/' is the front page */
export function referenceHashes(rows: Row[]) {
	const out: Record<string, Record<string, Set<string>>> = {};
	for (const row of rows.filter((r) => r.kind === 'reference')) {
		const seed = row.seed || 'none';
		const map = (out[seed] ??= {});
		for (const sha of [row.frontSha256, row.frontAgainSha256])
			(map['/'] ??= new Set()).add(sha);
		for (const page of row.pages) (map[page.path] ??= new Set()).add(page.sha256);
	}
	return Object.fromEntries(
		Object.entries(out).map(([seed, map]) => [
			seed,
			Object.fromEntries(Object.entries(map).map(([path, set]) => [path, [...set]]))
		])
	) as Record<string, Record<string, string[]>>;
}

/** each baked render row against the booted hash for its seed and path */
export function summarizeReplay(rows: Row[], references: ReturnType<typeof referenceHashes>) {
	const out: Record<string, any> = {};
	const renders = rows.filter((r) => r.kind === 'render');
	for (const [key, group] of by(
		renders,
		(r) => `${r.image}/${r.variant}/${r.seed || 'none'}/${r.position ?? 'first'}`
	)) {
		const failed = group.filter((r) => !r.ok);
		const ok = group.filter((r) => r.ok);
		const perPath: Record<string, any> = {};
		for (const [path, items] of by(ok, (r) => r.path)) {
			// seed R is the unseeded node set plus the rows the image's own first render wrote
			const seed = items[0]!.seed === 'R' ? 'none' : items[0]!.seed || 'none';
			const expected = references[seed]?.[path];
			perPath[path] = {
				n: items.length,
				matches: items.filter((r) => expected?.includes(r.sha256)).length,
				expected: expected?.length === 1 ? expected[0] : expected,
				distinctHashes: new Set(items.map((r) => r.sha256)).size
			};
		}
		out[key] = {
			rows: group.length,
			processes: new Set(group.map((r) => r.round)).size,
			failed: failed.length,
			firstError: failed[0]?.error?.slice(0, 500),
			failedStage: failed[0]?.stage,
			perPath,
			replay: ok[0]?.marks?.replay
		};
	}
	return out;
}

const armFields = [
	'totalMs',
	'openMs',
	'seedMs',
	'importMs',
	'factoryMs',
	'memoryMs',
	'instantiateMs',
	'pib_initMs',
	'bootMs',
	'mountsMs',
	'shimsMs',
	'kernelMs',
	'replayMs',
	'firstRenderMs',
	'secondRenderMs',
	'openCpuMs',
	'compileMs',
	'rssBytes'
];

/** timings per arm and position; saving is the plain median minus the arm median */
export function summarizeArms(rows: Row[]) {
	const arms = rows.filter((r) => r.kind === 'arm');
	const out: Record<string, any> = {};
	for (const [key, group] of by(arms, (r) => `${r.arm}/${r.position}`)) {
		const fields: Record<string, any> = {};
		for (const field of armFields) fields[field] = statsOf(group, field);
		out[key] = {
			n: group.length,
			fields,
			shas: [...new Set(group.flatMap((r) => [r.firstSha256, r.secondSha256]))],
			replayCounts: group[0]?.replayCounts
		};
	}
	const saving: Record<string, any> = {};
	for (const position of ['first', 'second']) {
		const plain = out[`plain/${position}`]?.fields.totalMs?.median;
		for (const name of ['boot', 'render']) {
			const arm = out[`${name}/${position}`]?.fields.totalMs?.median;
			if (plain === undefined || arm === undefined) continue;
			saving[`${name}/${position}`] = {
				plainMs: plain,
				armMs: arm,
				savedMs: plain - arm,
				ratio: arm / plain
			};
		}
	}
	return { arms: out, saving };
}

/** the three seed-coupling cases: matches against the booted hash of the same seed */
export function summarizeSeedTests(rows: Row[], references: ReturnType<typeof referenceHashes>) {
	return summarizeReplay(rows, references);
}

/** every row of a baked run names the module it ran on; one digest, one PHP version, no change */
export function summarizeInterpreter(files: Record<string, Row[]>) {
	const rows = Object.values(files).flat();
	const withInterp = rows.filter((row) => row.interp?.wasmSha256);
	const checks = rows.filter((row) => row.kind === 'interpCheck');
	return {
		rowsWithDigest: withInterp.length,
		rowsWithout: rows.length - withInterp.length,
		wasmSha256: [...new Set(withInterp.map((row) => row.interp.wasmSha256))],
		glueSha256: [...new Set(withInterp.map((row) => row.interp.glueSha256))],
		phpVersions: [
			...new Set(rows.filter((row) => row.kind === 'php').map((row) => row.version))
		],
		runsChecked: checks.length,
		allUnchanged: checks.every((row) => row.same)
	};
}

const kbToBytes = (kb: number) => kb * 1024;

/** workerd rows: cold is the first request of a fresh process, warm the later ones; noop removed */
export function summarizeWorkerd(rows: Row[]) {
	const modules = Object.fromEntries(
		rows
			.filter((r) => r.kind === 'wmodule')
			.map((r) => [
				r.variant,
				{
					moduleBytes: r.moduleBytes,
					gzipBytes: r.gzipBytes,
					pages: r.pages,
					valid: r.valid
				}
			])
	);
	const out: Record<string, any> = {};
	for (const [variant, group] of by(
		rows.filter((r) => r.kind === 'workerd' && r.ok),
		(r) => r.variant
	)) {
		const noop = group.flatMap((r) => r.noopMs as number[]);
		const noopMedian = median(noop);
		const cold = group.map((r) => r.firstMs - median(r.noopMs));
		const warm = group.flatMap((r) =>
			(r.warmMs as number[]).map((ms) => ms - median(r.noopMs))
		);
		const rss = (field: string) => stats(group.map((r) => kbToBytes(r.rssKb[field])));
		const grew = (to: string) =>
			stats(group.map((r) => kbToBytes(r.rssKb[to] - r.rssKb.start)));
		out[variant] = {
			operation: group[0]!.operation,
			processes: group.length,
			noopMs: { n: noop.length, median: noopMedian },
			startMs: stats(group.map((r) => r.startMs)),
			coldMs: stats(cold),
			warmMs: stats(warm),
			manyPerInstanceMs: stats(group.map((r) => (r.manyMs - median(r.noopMs)) / r.manyCount)),
			innerClockMs: stats(group.map((r) => r.firstInnerMs)),
			rssStartBytes: rss('start'),
			rssGrowthBytes: {
				afterFirst: grew('afterFirst'),
				afterMany: grew('afterMany'),
				held3: grew('held3'),
				touched3: grew('touched3'),
				dropped: grew('dropped')
			}
		};
	}
	return { modules, variants: out };
}

// #endregion

const bakedFiles = [
	'pin',
	'anatomy',
	'bake',
	'seed',
	'reference',
	'render',
	'replay',
	'seedtest',
	'arms',
	'workerd'
];

/** the 63.9 MiB uncompressed script limit of a deployed Worker, in bytes */
export const scriptLimitBytes = Math.floor(63.9 * 1024 * 1024);

/**
 * Module sizes against the plain module and the script limit. `moduleBytes` is the baked module,
 * `originalBytes` the plain one; the image an asset route would carry is the delta pages alone.
 * A `bundle` row (the host's dry-run upload with the plain module) gives the part of the bundle
 * that is not the module, so the bundle a baked module would make can be set against the limit.
 */
export function summarizeBundle(bakes: Row[], bundle?: Row) {
	const limitKiB = scriptLimitBytes / 1024;
	return bakes.map((row) => {
		const totalKiB = bundle && bundle.nonModuleKiB + row.moduleBytes / 1024;
		return {
			image: row.name,
			moduleBytes: row.moduleBytes,
			plainBytes: row.originalBytes,
			growthBytes: row.moduleBytes - row.originalBytes,
			deltaBytes: row.deltaBytes,
			deltaMiB: Math.round((row.deltaBytes / 1024 / 1024) * 100) / 100,
			deltaPages: row.deltaBytes / 65536,
			scriptLimitBytes,
			headroomBytes: scriptLimitBytes - row.moduleBytes,
			plainHeadroomBytes: scriptLimitBytes - row.originalBytes,
			...(bundle && {
				nonModuleKiB: bundle.nonModuleKiB,
				bundleKiB: Math.round(totalKiB * 100) / 100,
				limitKiB: Math.round(limitKiB * 100) / 100,
				overLimitKiB: Math.round((totalKiB - limitKiB) * 100) / 100
			})
		};
	});
}

/** the baked-image rows of one interpreter build: anatomy, bake, replay against a booted render, arms, workerd */
function summarizeBaked(read: (name: string) => Row[], withBundle = false) {
	const baked = Object.fromEntries(
		bakedFiles.map((name) => [name, read(`mac-baked-${name}.jsonl`)])
	);
	const references = referenceHashes(baked.reference!);
	return {
		interpreter: summarizeInterpreter(baked as Record<string, Row[]>),
		pin: baked.pin!.find((row) => row.kind === 'pin'),
		loadAverage1m: Object.fromEntries(
			Object.entries(baked).map(([name, rows]) => [name, loadRange(rows)])
		),
		anatomy: summarizeAnatomy(baked.anatomy!),
		dbstate: baked
			.anatomy!.filter((row) => row.kind === 'dbstate')
			.map((row) => ({
				round: row.round,
				rowsWritten: row.rowsWritten,
				changed: row.changed,
				seedBytes: row.seedBytes
			})),
		bake: baked.bake!.filter((row) => row.kind === 'bake'),
		...(withBundle && {
			bundle: summarizeBundle(
				baked.bake!.filter((row) => row.kind === 'bake'),
				baked.bake!.find((row) => row.kind === 'bundle')
			)
		}),
		seeds: baked.seed!.filter((row) => row.kind === 'seedgen'),
		references,
		plainAndFd: summarizeReplay(baked.render!, references),
		replay: summarizeReplay(baked.replay!, references),
		seedTests: summarizeSeedTests(baked.seedtest!, references),
		arms: summarizeArms(baked.arms!),
		workerd: summarizeWorkerd(baked.workerd!)
	};
}

export function analyzeBootImage(set: string) {
	const root = resultsRoot(set);
	const read = (name: string) =>
		existsSync(new URL(name, root)) ? parseRows(readRaw(root, name)) : [];
	const files = ['phases', 'anatomy', 'bake', 'deliver', 'retain', 'render'];
	const raw = Object.fromEntries(files.map((name) => [name, read(`mac-${name}.jsonl`)]));
	const phases = summarizePhases(raw.phases!);
	const delivery = summarizeDelivery(raw.deliver!);
	const summary = {
		environment: raw.phases!.find((row) => row.kind === 'environment'),
		loadAverage1m: Object.fromEntries(files.map((name) => [name, loadRange(raw[name]!)])),
		phases,
		anatomy: summarizeAnatomy(raw.anatomy!),
		bake: raw.bake!.filter((row) => row.kind === 'bake'),
		delivery,
		retain: summarizeRetain(raw.retain!),
		decision: decide(delivery, phases),
		baked: summarizeBaked(read),
		render: raw
			.render!.filter((row) => row.kind === 'render')
			.map((row) => ({ ...row, error: row.error?.slice(0, 600) }))
	};
	writeSummary(root, summary);
	return summary;
}

/** a result set that holds only the baked-image run of one interpreter build */
export function analyzeBakedBuild(set: string) {
	const root = resultsRoot(set);
	const read = (name: string) =>
		existsSync(new URL(name, root)) ? parseRows(readRaw(root, name)) : [];
	const summary = {
		environment: read('mac-baked-pin.jsonl').find((row) => row.kind === 'environment'),
		...summarizeBaked(read, true)
	};
	writeSummary(root, summary);
	return summary;
}
