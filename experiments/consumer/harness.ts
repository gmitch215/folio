import { BrowserFolio, type BrowserProgram, type BrowserWorkerPort } from '../../src/browser.ts';
import type { MemoryImport } from '../../src/memory.ts';
import { consumers } from './cases.ts';
import { measureConsumer, type Arm, type Report, type Row } from './measure.ts';

export interface HarnessRequest {
	consumer: string;
	pairs: number;
	warmup?: number;
	cases?: string[];
	budgetMs?: number;
}

interface Meta extends Omit<BrowserProgram, 'module'> {
	memories: MemoryImport[];
}

const hex = (buffer: ArrayBuffer) =>
	[...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Wraps a lane so the run messages and their JSON bytes can be counted. */
function countedLane(counter: { messages: number; bytes: number }) {
	return (): BrowserWorkerPort => {
		const worker = new Worker('/lane.js', { type: 'module' });
		return {
			postMessage(message: any) {
				if (message?.action === 'run') {
					counter.messages++;
					counter.bytes += JSON.stringify(message.call).length;
				}
				worker.postMessage(message);
			},
			addEventListener: worker.addEventListener.bind(worker),
			removeEventListener: worker.removeEventListener.bind(worker),
			terminate: () => worker.terminate()
		};
	};
}

export async function runConsumerHarness(request: HarnessRequest) {
	const rows: Row[] = [];
	const pools: BrowserFolio[] = [];
	const result: Record<string, any> = {
		kind: 'consumer-harness',
		consumer: request.consumer,
		userAgent: navigator.userAgent,
		hardwareConcurrency: navigator.hardwareConcurrency,
		crossOriginIsolated,
		jspi: typeof (WebAssembly as any).Suspending === 'function',
		rows
	};
	const started = performance.now();
	try {
		const consumer = consumers[request.consumer];
		if (!consumer) throw new Error(`unknown consumer ${request.consumer}`);
		const [bytes, meta] = await Promise.all([
			fetch(`/consumer/${request.consumer}.wasm`).then((response) => response.arrayBuffer()),
			fetch(`/consumer/${request.consumer}.json`).then(
				(response) => response.json() as Promise<Meta>
			)
		]);
		const module = await WebAssembly.compile(bytes);
		const program: BrowserProgram = { ...meta, module };
		const arms: Arm[] = [];
		const openMs: Record<string, number> = {};
		const native = (() => {
			const begin = performance.now();
			const fresh = consumer.fresh(module, meta.memories);
			const instance = new WebAssembly.Instance(module, fresh.imports);
			openMs.native = performance.now() - begin;
			const api = {
				exports: instance.exports,
				memory: fresh.memory ?? (instance.exports.memory as WebAssembly.Memory)
			};
			return {
				name: 'native',
				api,
				async run(calls) {
					return {
						values: calls.map((call) =>
							(api.exports[call.export] as CallableFunction)(...call.args)
						)
					};
				}
			} satisfies Arm;
		})();
		arms.push(native);
		const coverage: Record<string, unknown> = {};
		for (const width of consumer.widths) {
			const begin = performance.now();
			const fresh = consumer.fresh(module, meta.memories);
			const counter = { messages: 0, bytes: 0 };
			const pool = await BrowserFolio.open(program, {
				memory: fresh.memory,
				imports: fresh.imports,
				workers: width,
				workerFactory: countedLane(counter)
			});
			pools.push(pool);
			openMs[`folio-${width}`] = performance.now() - begin;
			const api = {
				exports: pool.exports,
				memory: fresh.memory ?? (pool.exports.memory as WebAssembly.Memory)
			};
			for (const entry of Object.keys(meta.loops)) coverage[entry] = pool.inspect(entry);
			arms.push({
				name: `folio-${width}`,
				api,
				async run(calls) {
					counter.messages = 0;
					counter.bytes = 0;
					const reports: Awaited<ReturnType<BrowserFolio['run']>>[] = [];
					for (const call of calls) reports.push(await pool.run(call.export, call.args));
					const report: Report = {
						workers: Math.max(0, ...reports.map((item) => item.workers)),
						regions: reports.reduce((sum, item) => sum + item.regions, 0),
						mode: [...new Set(reports.map((item) => item.mode))].join('+'),
						reason: [
							...new Set(reports.map((item) => item.reason).filter(Boolean))
						].join('+'),
						messages: counter.messages,
						copiedBytes: counter.bytes
					};
					return { values: reports.flatMap((item) => item.values), report };
				}
			});
		}
		rows.push({
			kind: 'environment',
			consumer: request.consumer,
			moduleBytes: bytes.byteLength,
			loops: Object.keys(meta.loops),
			nativeGuards: Object.keys(meta.native ?? {}),
			reasons: meta.reasons,
			openMs,
			arms: arms.map((arm) => arm.name),
			arenaBytes: Object.fromEntries(
				arms.map((arm) => [arm.name, arm.api.memory.buffer.byteLength])
			),
			coverage
		});
		const spec = request.cases
			? {
					...consumer.spec,
					cases: consumer.spec.cases.filter((item) => request.cases!.includes(item.name))
				}
			: consumer.spec;
		const outcome = await measureConsumer(
			spec,
			arms,
			{
				pairs: request.pairs,
				warmup: request.warmup ?? 2,
				budgetMs: request.budgetMs ?? 35000,
				fullDigest: async (api) =>
					hex(
						await crypto.subtle.digest(
							'SHA-256',
							new Uint8Array(api.memory.buffer).slice()
						)
					)
			},
			(row) => rows.push(row)
		);
		result.truncated = outcome.truncated;
		result.completed = outcome.completed;
		result.passed = true;
	} catch (error) {
		result.passed = false;
		result.error = String(error instanceof Error ? error.stack : error);
	} finally {
		await Promise.all(pools.map((pool) => pool.close()));
		result.elapsedMs = performance.now() - started;
	}
	return result;
}

(globalThis as any).runConsumerHarness = runConsumerHarness;
