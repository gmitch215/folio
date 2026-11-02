import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { Worker } from 'node:worker_threads';
import { prepare, prepareContext } from '../../src/compiler.ts';
import { admissionSeam } from '../../src/iteration-admission.ts';
import { Folio } from '../../src/node.ts';
import { SlicePool } from '../../src/slices.ts';
import { TaskPool } from '../../src/tasks.ts';
import {
	clearOutput,
	hostMath,
	instantiate,
	moduleBytes,
	outputOf,
	recordsOf,
	specOf,
	writeRecords
} from './c21-common.ts';
import { layoutOf } from './c21-kernels.ts';
import { encodeTask } from './c21-worker.ts';
import { researchEnvironment } from './environment.ts';

// bulk bench: serial, automatic, forced and explicit arms over n independent records of one kernel
const [mode, id, output, roundsArg = '5', widthArg = '8'] = process.argv.slice(2);
if (!['counters', 'timed'].includes(mode ?? '') || !id || !output)
	throw new Error('usage: c21-bench.ts counters|timed ID OUTPUT.jsonl [ROUNDS] [WIDTH]');
const spec = specOf(id);
const n = Number(process.env.C21_N ?? spec.n);
const rounds = Number(roundsArg),
	width = Number(widthArg),
	warmups = 2;
writeFileSync(output, '', { flag: 'wx' });
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');

const records = recordsOf(spec, n);
const inputCap = Math.max(...records.map((r) => r.input.length));
const layout = layoutOf(
	spec,
	n,
	records.map((r) => r.input.length)
);
const bytes = moduleBytes(spec);
const setupArgs = [layout.config, spec.config?.perRecord ? n : 1, spec.config?.nfft ?? 0];

const native = instantiate(spec, layout);
if (spec.config) native.exports.setup!(...setupArgs);
writeRecords(native.memory, spec, layout, records);
const nativeRun = () => {
	clearOutput(native.memory, spec, layout, n);
	const cpu = process.cpuUsage(),
		start = performance.now();
	native.exports.bulk!(layout.table, n, layout.out);
	return { wallMs: performance.now() - start, cpuMs: cpuMs(cpu) };
};
const cpuMs = (since: NodeJS.CpuUsage) => {
	const used = process.cpuUsage(since);
	return (used.user + used.system) / 1000;
};
nativeRun();
const expected = Uint8Array.from(outputOf(native.memory, spec, layout, n));
assert.ok(
	expected.some((byte) => byte !== 0),
	'serial output is empty'
);
const equal = (actual: Uint8Array) => Buffer.compare(actual, expected) === 0;

const summarize = (report: any) => {
	const it = report?.iteration;
	return {
		mode: report?.mode,
		extraction: report?.extraction,
		reason: report?.reason,
		detail: report?.detail,
		workers: it?.workers,
		regions: it?.regions ?? report?.regions,
		replayed: it?.replayed ?? report?.replayed,
		rolledBack: it?.rolledBack,
		fallbacks: it?.fallbacks ?? report?.fallbacks,
		exhausted: it?.exhausted,
		traps: it?.traps,
		batches: it?.batches,
		failedBatches: it?.failedBatches,
		undoEntries: it?.undoEntries,
		maxLogEntries: it?.maxLogEntries,
		undoPerIteration: it?.regions
			? it.undoEntries / (it.regions + it.rolledBack || 1)
			: undefined,
		conflicts: it?.conflicts,
		serial: it?.serial,
		stopped: it?.stopped,
		admission: it?.admission,
		dispatchMs: it?.dispatchMs,
		validationMs: it?.validationMs,
		rollbackMs: it?.rollbackMs,
		replayMs: it?.replayMs,
		workerRunMs: it?.workerRunMs,
		workerScanMs: it?.workerScanMs,
		workerMarkMs: it?.workerMarkMs,
		workerScanWords: it?.workerScanWords,
		workerScanSet: it?.workerScanSet,
		readWindows: it?.readWindows,
		readWindowRefused: it?.readWindowRefused,
		readWindowGate: it?.readWindowGate
	};
};

interface Open {
	run: () => Promise<{ wallMs: number; cpuMs: number; out: Uint8Array; report?: object }>;
	close: () => Promise<void>;
}
const poolArm = (forced: boolean, shared: boolean) => async (): Promise<Open> => {
	// a refused route cannot take a shared memory (the open throws, recorded in RESULT); run the older path
	const refused = refusal.iterationEligible === false;
	const memory = new WebAssembly.Memory({
		initial: layout.pages,
		maximum: refused ? layout.pages : 65536,
		shared: !refused
	});
	void shared;
	const env = { memory, ...(spec.imports ? hostMath() : {}) };
	const pool = await Folio.open(
		refused && forced ? prepare(bytes, { minimumRegionWork: 0 }) : bytes,
		refused
			? { imports: { env }, workers: width }
			: {
					memory,
					workers: width,
					imports: spec.imports ? { env: hostMath() } : undefined,
					iterationReadWindows: process.env.C21_READWIN === '1',
					iterationReadSummary: process.env.C21_SUMMARY === '1',
					iterationSecondChance: process.env.C21_SECOND === '1',
					iterationLogCeiling: process.env.C21_LOGCEILING
						? Number(process.env.C21_LOGCEILING)
						: undefined
				}
	);
	if (spec.config) await pool.run('setup', setupArgs);
	writeRecords(pool.memory, spec, layout, records);
	return {
		run: async () => {
			clearOutput(pool.memory, spec, layout, n);
			admissionSeam.force = forced;
			admissionSeam.trace = process.env.C21_TRACE === '1';
			admissionSeam.gate = process.env.C21_GATE !== '0';
			admissionSeam.estimator =
				(process.env.C21_ESTIMATOR as 'min' | 'median' | 'mean' | 'q75') ?? 'median';
			const cpu = process.cpuUsage(),
				start = performance.now();
			const report = await pool.run('bulk', [layout.table, n, layout.out]);
			const wallMs = performance.now() - start,
				used = cpuMs(cpu);
			admissionSeam.force = false;
			return {
				wallMs,
				cpuMs: used,
				out: outputOf(pool.memory, spec, layout, n),
				report: summarize(report)
			};
		},
		close: () => pool.close()
	};
};

const explicitArm = (chunk: number) => async (): Promise<Open> => {
	const plan = prepareContext(bytes);
	assert.deepEqual(plan.reasons, [], 'checkpoint refused');
	const module = new WebAssembly.Module(Uint8Array.from(plan.bytes));
	const pool = new TaskPool(width),
		workers: Worker[] = [];
	await Promise.all(
		Array.from({ length: width }, async (_, index) => {
			const link = pool.link(index);
			const worker = new Worker(new URL('./c21-worker.ts', import.meta.url), {
				workerData: { c21Worker: true, spec: spec.id, module, plan, link, chunk, inputCap },
				transferList: [link.port]
			});
			workers.push(worker);
			await new Promise<void>((resolve, reject) => {
				worker.once('message', () => resolve());
				worker.once('error', reject);
			});
		})
	);
	const groups: (typeof records)[] = [];
	for (let at = 0; at < n; at += chunk) groups.push(records.slice(at, at + chunk));
	const share = process.env.C21_SHARED === '1';
	const tasks = groups.map((group) => encodeTask(spec, group, share));
	const out = new Uint8Array(n * spec.slot);
	return {
		run: async () => {
			const cpu = process.cpuUsage(),
				start = performance.now();
			const results = await pool.run(
				tasks.map((task) => ['bulk', task] as [string, Uint8Array]),
				{ share }
			);
			const wallMs = performance.now() - start,
				used = cpuMs(cpu);
			let at = 0;
			for (const result of results) {
				out.set(result.bytes, at);
				at += result.bytes.length;
			}
			const sums = await Promise.all(
				Array.from({ length: width }, () => pool.joinAsync(pool.submit('stats')))
			);
			const phases: Record<string, number> = {};
			for (const sum of sums)
				for (const [key, value] of Object.entries(
					JSON.parse(sum.text()) as Record<string, number>
				))
					phases[key] = (phases[key] ?? 0) + value;
			return {
				wallMs,
				cpuMs: used,
				out,
				report: {
					tasks: tasks.length,
					chunk,
					shared: share,
					overwrite: process.env.C21_OVERWRITE === '1',
					bytes: tasks.reduce((a, t) => a + t.length, 0),
					phases
				}
			};
		},
		close: async () => {
			pool.close();
			await Promise.all(workers.map((worker) => worker.terminate()));
		}
	};
};

// no copy and no reset: one shared memory holds the records, each worker runs a slice of the bulk entry
const inplaceArm = async (): Promise<Open> => {
	const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: 65536, shared: true });
	const pool = await SlicePool.open(bytes, {
		memory,
		workers: width,
		imports: spec.imports ? new URL('./c21-imports.ts', import.meta.url) : undefined
	});
	if (spec.config) await pool.run('setup', 1, () => setupArgs);
	writeRecords(memory, spec, layout, records);
	return {
		run: async () => {
			clearOutput(memory, spec, layout, n);
			const cpu = process.cpuUsage(),
				start = performance.now();
			const report = await pool.run(
				'bulk',
				n,
				(from, to) => [layout.table + 16 * from, to - from, layout.out + from * spec.slot],
				{
					grain: process.env.C21_GRAIN ? Number(process.env.C21_GRAIN) : undefined,
					audit: process.env.C21_AUDIT === '1'
				}
			);
			const wallMs = performance.now() - start,
				used = cpuMs(cpu);
			return {
				wallMs,
				cpuMs: used,
				out: Uint8Array.from(outputOf(memory, spec, layout, n)),
				report: { tasks: report.slices, inplace: true }
			};
		},
		close: () => pool.close()
	};
};

const refusal = (() => {
	const prepared = prepare(bytes);
	return {
		iterationEligible: prepared.iterationRoute?.eligible,
		diagnostics: prepared.iterationRoute?.diagnostics.slice(0, 4)
	};
})();
emit({
	...researchEnvironment({ mode, id, n, rounds, width, slot: spec.slot, inputBytes: inputCap }),
	spec: { ...spec, makeInput: undefined, makeAux: undefined },
	route: refusal,
	layoutPages: layout.pages
});

const arms: [string, () => Promise<Open>][] =
	mode === 'counters'
		? [
				['automatic', poolArm(false, true)],
				['forced', poolArm(true, true)]
			]
		: [
				['automatic', poolArm(false, true)],
				...(refusal.iterationEligible === false && !process.env.C21_FORCE_REFUSED
					? []
					: ([['forced', poolArm(true, true)]] as [string, () => Promise<Open>][])),
				['explicit', explicitArm(Math.ceil(n / width))],
				['explicit-1', explicitArm(1)]
			];
const only = process.env.C21_ARMS?.split(',');
const optional: [string, () => Promise<Open>][] = [['inplace', inplaceArm]];
const ordered = only
	? only.flatMap((name) => [...arms, ...optional].filter(([arm]) => arm === name))
	: arms;
for (const [name, open] of ordered) {
	const arm = await open();
	try {
		const count = mode === 'counters' ? 2 : rounds;
		const warm = mode === 'counters' ? 0 : warmups;
		for (let round = -warm; round < count; round++) {
			const order = round % 2 ? ['arm', 'native'] : ['native', 'arm'];
			for (const which of order) {
				const loadBefore = loadavg();
				if (which === 'native') {
					const sample = nativeRun();
					if (round >= 0)
						emit({
							kind: 'sample',
							case: name,
							arm: 'native',
							round,
							...sample,
							load: loadBefore,
							passed: true
						});
					continue;
				}
				const sample = await arm.run();
				const passed = equal(sample.out);
				if (round >= 0)
					emit({
						kind: 'sample',
						case: name,
						arm: name,
						round,
						wallMs: sample.wallMs,
						cpuMs: sample.cpuMs,
						load: loadBefore,
						passed,
						report: sample.report
					});
				assert.ok(passed, `${id} ${name} output differs from serial`);
			}
		}
	} finally {
		await arm.close();
	}
	await new Promise((resolve) => setTimeout(resolve, 200));
}
emit({ kind: 'closed', complete: true });
console.log('done', output);
process.exit(0);
