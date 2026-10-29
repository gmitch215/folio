import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';
import { openOldBuild } from './old-build.ts';

export interface Call {
	export: string;
	args: number[];
}

export interface Api {
	exports: WebAssembly.Exports;
	memory: WebAssembly.Memory;
}

export interface Case {
	name: string;
	/** runs untimed on raw exports and returns the timed calls */
	prepare(api: Api): Call[];
	/** runs untimed after the memory digest */
	finish?(api: Api): void;
	/** one ordered `runAll` batch instead of one `run` per call */
	batch?: boolean;
}

export interface Consumer {
	name: string;
	bytes: Uint8Array;
	/** fresh imports per instance; a module that exports its memory needs none */
	imports?(): { imports: WebAssembly.Imports; memory?: WebAssembly.Memory };
	cases: Case[];
}

export interface Options {
	/** called with every row as it is produced */
	sink?(row: Record<string, any>): void;
	pairs?: number;
	widths?: number[];
	cases?: string[];
	warmup?: number;
	/** adds an `old-N` arm per width from the archived pre-admission build */
	old?: boolean;
	/** Diagnostic admission override; undefined retains the shipped compiler default. */
	minimumRegionWork?: number;
}

type Row = Record<string, any>;

/** Runs every arm over every case in alternating rounds and returns the rows. */
export async function measure(consumer: Consumer, options: Options = {}): Promise<Row[]> {
	const pairs = options.pairs ?? 20;
	const widths = options.widths ?? [1, 2, 4, 8];
	const warmup = options.warmup ?? 2;
	const cases = consumer.cases.filter(
		(item) => !options.cases || options.cases.includes(item.name)
	);
	const rows: Row[] = [];
	const emit = (row: Row) => {
		rows.push(row);
		options.sink?.(row);
	};
	const module = new WebAssembly.Module(Uint8Array.from(consumer.bytes));
	const preparedAt = performance.now();
	const plan = prepare(consumer.bytes, { minimumRegionWork: options.minimumRegionWork });
	const prepareMs = performance.now() - preparedAt;
	const oldBuild = options.old ? await openOldBuild() : undefined;
	const oldPreparedAt = performance.now();
	const oldPlan = oldBuild?.prepare(consumer.bytes);
	const oldPrepareMs = performance.now() - oldPreparedAt;
	const fresh = () => consumer.imports?.() ?? { imports: {} as WebAssembly.Imports };

	interface Arm {
		name: string;
		api: Api;
		openMs: number;
		run(calls: Call[], batch: boolean): Promise<{ values: unknown[]; report?: any[] }>;
		close(): Promise<number>;
		inspect?(entry: string): unknown;
		diagnostics?: readonly string[];
	}

	async function openArm(width: number | 'native', build: 'new' | 'old' = 'new'): Promise<Arm> {
		const started = performance.now();
		const { imports, memory } = fresh();
		if (width === 'native') {
			const instance = new WebAssembly.Instance(module, imports);
			const api = {
				exports: instance.exports,
				memory: memory ?? (instance.exports.memory as WebAssembly.Memory)
			};
			return {
				name: 'native',
				api,
				openMs: performance.now() - started,
				async run(calls) {
					return {
						values: calls.map((call) =>
							(api.exports[call.export] as CallableFunction)(...call.args)
						)
					};
				},
				close: async () => 0
			};
		}
		const old = build === 'old' ? oldBuild! : undefined;
		const pool = await (old?.Folio ?? Folio).open(old ? oldPlan! : plan, {
			imports,
			workers: width,
			profile: true
		});
		const api = { exports: pool.exports, memory: pool.memory };
		return {
			name: `${old ? 'old' : 'folio'}-${width}`,
			api,
			openMs: performance.now() - started,
			inspect: (entry) => pool.inspect(entry),
			diagnostics: pool.diagnostics,
			async run(calls, batch) {
				if (batch) {
					const report = await pool.runAll(calls);
					return { values: report.values, report: [report] };
				}
				const reports = [];
				for (const call of calls) reports.push(await pool.run(call.export, call.args));
				return { values: reports.flatMap((report) => report.values), report: reports };
			},
			async close() {
				const closing = performance.now();
				await pool.close();
				return performance.now() - closing;
			}
		};
	}

	const arms = [await openArm('native')];
	for (const width of widths) {
		if (oldBuild) arms.push(await openArm(width, 'old'));
		arms.push(await openArm(width));
	}
	try {
		const probe = arms.find((arm) => arm.inspect);
		emit({
			kind: 'environment',
			consumer: consumer.name,
			node: process.version,
			v8: process.versions.v8,
			cpu: cpus()[0]!.model,
			hardwareThreads: cpus().length,
			moduleBytes: consumer.bytes.length,
			moduleSha256: createHash('sha256').update(consumer.bytes).digest('hex'),
			prepareMs,
			openMs: Object.fromEntries(arms.map((arm) => [arm.name, arm.openMs])),
			arms: arms.map((arm) => arm.name),
			pairs,
			warmup,
			minimumRegionWork: options.minimumRegionWork,
			functionExports: WebAssembly.Module.exports(module).filter(
				(item) => item.kind === 'function'
			).length,
			diagnostics: probe?.diagnostics?.length
		});
		const coverage: Record<string, unknown> = {};
		for (const item of cases) {
			for (let round = -warmup; round < pairs; round++) {
				const digests = new Map<string, string>();
				for (let turn = 0; turn < arms.length; turn++) {
					const arm = arms[(turn + round + warmup) % arms.length]!;
					const calls = item.prepare(arm.api);
					const cpuStart = process.cpuUsage();
					const start = performance.now();
					const result = await arm.run(calls, item.batch ?? false);
					const wallMs = performance.now() - start;
					const cpu = process.cpuUsage(cpuStart);
					const digest = createHash('sha256')
						.update(new Uint8Array(arm.api.memory.buffer))
						.update(
							JSON.stringify(result.values, (_, value) =>
								typeof value === 'bigint' ? `${value}n` : value
							)
						)
						.digest('hex');
					item.finish?.(arm.api);
					digests.set(arm.name, digest);
					if (round < 0) continue;
					const reports = result.report ?? [];
					for (const call of calls)
						if (arm.inspect && !(call.export in coverage))
							coverage[call.export] = arm.inspect(call.export);
					emit({
						kind: 'sample',
						consumer: consumer.name,
						name: `${consumer.name}/${item.name}`,
						arm: arm.name,
						round,
						calls: calls.length,
						wallMs,
						cpuMs: (cpu.user + cpu.system) / 1000,
						outputSha256: digest,
						passed: true,
						dispatched: reports.length
							? {
									workers: Math.max(
										0,
										...reports.map((report) => report.workers)
									),
									regions: reports.reduce(
										(sum, report) => sum + report.regions,
										0
									),
									replayed: reports.reduce(
										(sum, report) => sum + report.replayed,
										0
									),
									fallbacks: reports.reduce(
										(sum, report) => sum + report.fallbacks,
										0
									),
									mode: [...new Set(reports.map((report) => report.mode))].join(
										'+'
									),
									reason: [
										...new Set(
											reports.map((report) => report.reason).filter(Boolean)
										)
									].join('+'),
									workerCpuMs: reports.reduce(
										(sum, report) =>
											sum +
											(report.profile?.workerCpuMs.reduce(
												(a: number, b: number) => a + b,
												0
											) ?? 0),
										0
									)
								}
							: undefined,
						load: loadavg()
					});
				}
				if (new Set(digests.values()).size !== 1)
					throw new Error(
						`${item.name} round ${round}: memory or returns differ from native`
					);
			}
		}
		const closeMs: Record<string, number> = {};
		for (const arm of arms.splice(0)) closeMs[arm.name] = await arm.close();
		emit({ kind: 'closed', closeMs, coverage });
	} finally {
		for (const arm of arms) await arm.close();
	}
	return rows;
}

// usage: [FOLIO_OLD_BUILD=1] node scripts/probe/consumer.ts CONSUMER.ts OUTPUT.jsonl [PAIRS] [WORKERS,...] [CASE,...]
if (import.meta.main) {
	const [file, output, pairsArg, workersArg, casesArg] = process.argv.slice(2);
	if (!file || !output)
		throw new Error('usage: consumer.ts CONSUMER.ts OUTPUT.jsonl [PAIRS] [WORKERS] [CASES]');
	const consumer: Consumer = (await import(pathToFileURL(resolve(file)).href)).default;
	writeFileSync(output, '');
	await measure(consumer, {
		pairs: pairsArg ? Number(pairsArg) : undefined,
		widths: workersArg?.split(',').map(Number),
		cases: casesArg?.split(','),
		old: process.env.FOLIO_OLD_BUILD === '1',
		sink: (row) => appendFileSync(output, JSON.stringify(row) + '\n')
	});
}
