import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import { consumerRoot, resolveConsumer } from './consumer-root.ts';
import type { HookConfig } from './worksp-hooks.ts';

// private PHP contexts: N worker threads, each with its own prepared PHP instance and state.
// Only the compiled Wasm module (and the read-only seed and ROM files) is shared between them.
// usage: const contexts = await openContexts({ count: 4, kind: 'plain', mode: 'native' })
export interface ContextOptions {
	count: number;
	kind: 'plain' | 'drupal';
	/** native binds the original module; folio opens it through Folio.open with the plan */
	mode: 'native' | 'folio';
	/** a Drupal host checkout with a restored .interp */
	consumer?: string;
	/** interpreter file relative to the consumer */
	interp?: string;
	/** prepared plan for folio mode, built or cached by the caller */
	plan?: any;
	/** override for the folio library source directory */
	srcUrl?: string;
	/** a prebuilt worker bundle, for machines without the consumer's TypeScript sources */
	bundle?: string;
	workers?: number;
	/** replaces the ini lines that configure the code cache (the default turns it off) */
	opcache?: string[];
	/** a replacement for the consumer's module; with `instrument` it must import folio.ci */
	module?: WebAssembly.Module;
	/** binds folio.ci in each context so call_indirect sites report their targets */
	instrument?: boolean;
	/** binds the work-span hooks in each context; the module must come from instrumentWorksp */
	worksp?: HookConfig;
	/** old generation limit of each worker, default 512 */
	heapMb?: number;
	/** extra workerData and transferables for one context, such as a task bridge port */
	perContext?: (index: number) => { data: Record<string, unknown>; transfer?: any[] };
}

export interface ContextRun {
	index: number;
	startMs: number;
	endMs: number;
	cpuMs: number;
	sha256: string;
	memoryBytes: number;
	output?: string;
	error?: string;
	[extra: string]: unknown;
}

export interface ContextBoot {
	index: number;
	threadId: number;
	boot: Record<string, number>;
	memoryBytes: number;
}

const here = new URL('.', import.meta.url);

/** bundles the worker with the consumer's TypeScript and the timed inflate wrapper */
export async function buildWorker(consumer: string, outfile: string) {
	mkdirSync(join(outfile, '..'), { recursive: true });
	const { build } = await import('esbuild');
	await build({
		entryPoints: [new URL('./php-context-worker.ts', here).pathname],
		outfile,
		bundle: true,
		platform: 'node',
		format: 'esm',
		logLevel: 'error',
		external: ['node:*'],
		plugins: [
			{
				name: 'consumer',
				setup(builder) {
					builder.onResolve({ filter: /^consumer:/ }, (args) => ({
						path: resolveConsumer(consumer, args.path)
					}));
					builder.onResolve({ filter: /^fflate-real$/ }, () =>
						builder.resolve('fflate', {
							resolveDir: consumer,
							kind: 'import-statement'
						})
					);
					builder.onResolve({ filter: /^fflate$/ }, (args) =>
						args.importer.endsWith('lazy-fs.ts')
							? { path: new URL('./timed-fflate.ts', here).pathname }
							: undefined
					);
				}
			}
		]
	});
	return outfile;
}

/** one statement the Drupal SQL bridge ran; blobs are described by length */
export interface SqlStatement {
	text: string;
	params: unknown[];
	rows: number;
	rowsWritten: number;
	ms: number;
}

/** the page a render request produces and the caches emptied before it */
export interface RenderOptions {
	path?: string;
	bins?: string[];
}

export interface Contexts {
	readonly count: number;
	readonly boots: ContextBoot[];
	/** runs one PHP snippet in one context */
	run(index: number, code: string, keep?: boolean): Promise<ContextRun>;
	/** runs the same snippet (or one per context) in the listed contexts at once */
	runAll(code: string | string[], indices?: number[], keep?: boolean): Promise<ContextRun[]>;
	/** the uncached Drupal render of a path (default `/`) in the listed contexts at once (kind drupal) */
	render(indices?: number[], options?: RenderOptions): Promise<ContextRun[]>;
	/** starts recording the SQL statements of one Drupal context, or returns them and stops */
	sqlLog(index: number, action: 'start' | 'take'): Promise<SqlStatement[]>;
	/** reads every file under a directory of one context's Emscripten FS */
	exportFiles(index: number, dir: string): Promise<Record<string, Uint8Array>>;
	/** call_indirect counts of one instrumented context: [site, target, count] triples, then resets */
	/** runs one request (or the Drupal render) under the work-span hooks */
	worksp(
		index: number,
		request: { code?: string; render?: boolean; input?: object; options?: object }
	): Promise<any>;
	indirectCounts(index: number): Promise<{ triples: number[]; targets: Record<number, string> }>;
	/** copies one context's Wasm memory (and the stack pointer value the caller gives) into another */
	snapshot(
		from: number,
		to: number
	): Promise<{ bytes: number; copyMs: number; adoptMs: number; grewBytes: number }>;
	/** how many task servers the owner (index 0) spreads submitted tasks over */
	setWidth(index: number, width: number): Promise<void>;
	/** writes files into one context's FS before it runs anything */
	importFiles(index: number, files: Record<string, Uint8Array>): Promise<void>;
	close(): Promise<void>;
}

export async function openContexts(options: ContextOptions): Promise<Contexts> {
	const consumer = consumerRoot(options.consumer);
	const interp = options.interp ?? '.interp/php8.5-worker.tuned.mjs';
	const original = readFileSync(join(consumer, '.interp/php8.5.tuned.wasm'));
	const module = options.module ?? new WebAssembly.Module(original);
	const bundle =
		options.bundle ??
		(await buildWorker(consumer, new URL('../../build/php-context-worker.mjs', here).pathname));
	const srcUrl = options.srcUrl ?? new URL('../../src/', here).href;
	if (options.mode === 'folio' && !options.plan) throw new Error('folio mode needs a plan');
	const workers: Worker[] = [];
	const boots: ContextBoot[] = [];
	const waiting = new Map<number, (value: ContextRun) => void>();
	let nextId = 0;
	await Promise.all(
		Array.from(
			{ length: options.count },
			(_, index) =>
				new Promise<void>((done, fail) => {
					const extra = options.perContext?.(index);
					const worker = new Worker(bundle, {
						workerData: {
							index,
							kind: options.kind,
							mode: options.mode,
							consumer,
							interp,
							module,
							plan: options.plan,
							srcUrl,
							workers: options.workers ?? 2,
							opcache: options.opcache,
							instrument: options.instrument,
							worksp: options.worksp,
							...extra?.data
						},
						transferList: extra?.transfer,
						resourceLimits: { maxOldGenerationSizeMb: options.heapMb ?? 512 }
					});
					workers[index] = worker;
					worker.on('message', (message) => {
						if (message.type === 'ready') {
							boots[index] = message;
							done();
						} else if (message.type === 'error') fail(new Error(message.error));
						else if (message.type === 'result') waiting.get(message.id)?.(message);
					});
					worker.on('error', fail);
				})
		)
	);
	const send = (index: number, message: object, keep = false) =>
		new Promise<ContextRun>((resolve, reject) => {
			const id = nextId++;
			waiting.set(id, (result) => {
				waiting.delete(id);
				if (result.error) reject(new Error(result.error));
				else resolve(result);
			});
			workers[index]!.postMessage({ ...message, id, keep });
		});
	const all = Array.from({ length: options.count }, (_, i) => i);
	return {
		count: options.count,
		boots,
		run: (index, code, keep) => send(index, { type: 'run', code }, keep),
		runAll: (code, indices = all, keep) =>
			Promise.all(
				indices.map((index, k) =>
					send(index, { type: 'run', code: Array.isArray(code) ? code[k] : code }, keep)
				)
			),
		render: (indices = all, options = {}) =>
			Promise.all(indices.map((index) => send(index, { type: 'render', ...options }))),
		sqlLog: async (index, action) =>
			((await send(index, { type: 'sqlLog', action })) as any).log as SqlStatement[],
		exportFiles: async (index, dir) =>
			((await send(index, { type: 'exportFiles', dir })) as any).files,
		worksp: async (index, request) => send(index, { type: 'worksp', ...request }),
		indirectCounts: async (index) => (await send(index, { type: 'counts' })) as any,
		snapshot: async (from, to) => {
			const t0 = performance.now();
			const copied = (await send(from, { type: 'memoryOut' })) as any;
			const received = await send(to, { type: 'memoryIn', memory: copied.memory });
			return {
				bytes: copied.memory.byteLength,
				copyMs: performance.now() - t0,
				...(received as any)
			};
		},
		setWidth: async (index, width) => {
			await send(index, { type: 'width', width });
		},
		importFiles: async (index, files) => {
			await send(index, { type: 'importFiles', files });
		},
		async close() {
			await Promise.all(
				workers.map(
					(worker) =>
						new Promise<void>((done) => {
							worker.once('exit', () => done());
							worker.postMessage({ type: 'close' });
						})
				)
			);
		}
	};
}

/** wall time during which two or more of the intervals were running at once */
export function overlapMs(runs: { startMs: number; endMs: number }[]) {
	const events = runs.flatMap((r) => [
		[r.startMs, 1],
		[r.endMs, -1]
	]) as [number, number][];
	events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let active = 0;
	let last = 0;
	let total = 0;
	for (const [time, delta] of events) {
		if (active >= 2) total += time - last;
		active += delta;
		last = time;
	}
	return total;
}

export const loadPlan = (path: string) => deserialize(readFileSync(path));
