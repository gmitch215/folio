import type { BrowserProgram } from '../../../src/browser.ts';
import { BrowserFolio } from '../../../src/browser.ts';

/** Exercises a whole ordinary entry; the library, rather than the probe, derives every partition. */
export async function runBrowserExtractionProbe() {
	const raw: Record<string, unknown>[] = [];
	const pools: BrowserFolio[] = [];
	const started = performance.now();
	const result: Record<string, any> = {
		kind: 'browser-automatic-counted-loop',
		userAgent: navigator.userAgent,
		hardwareConcurrency: navigator.hardwareConcurrency,
		crossOriginIsolated,
		jspi: typeof (WebAssembly as any).Suspending === 'function',
		jspiDisabledForProbe: Boolean((globalThis as any).folioJspiDisabledForProbe),
		jspiOriginallyAvailable:
			(globalThis as any).folioJspiOriginallyAvailable ??
			typeof (WebAssembly as any).Suspending === 'function',
		mechanism: 'counted-loop-without-jspi',
		raw
	};
	const ensure = (condition: unknown, message: string) => {
		if (!condition) throw new Error(message);
	};
	try {
		ensure(
			crossOriginIsolated && typeof SharedArrayBuffer === 'function',
			'isolation unavailable'
		);
		const [source, metadata] = await Promise.all([
			fetch('/fixture.wasm').then(async (response) => {
				ensure(response.ok, 'fixture request failed');
				return response.arrayBuffer();
			}),
			fetch('/extraction.json').then(async (response) => {
				ensure(response.ok, 'metadata request failed');
				return response.json();
			})
		]);
		const module = await WebAssembly.compile(source);
		const program: BrowserProgram = { ...metadata, module };
		const memory = new WebAssembly.Memory({ initial: 4096, maximum: 8192, shared: true });
		const bytes = new Uint8Array(memory.buffer);
		for (let index = 0; index < bytes.length; index += 4096) bytes[index] = 7;
		const marker = new Int32Array(memory.buffer)[0];
		const widths = [1, 2, 4, 8];
		for (const width of widths) {
			const pool = await BrowserFolio.open(program, {
				memory,
				workers: width,
				workerURL: '/extraction-lane.js',
				minimumParallelWork: 0
			});
			pools.push(pool);
			ensure(new Int32Array(memory.buffer)[0] === marker, 'alias marker restoration');
			ensure(pool.inspect('program').nativeGuard, 'compiler-native guard missing');
			ensure(pool.inspect('program').workers === (width === 1 ? 0 : width), 'lane admission');
		}
		const owner = new WebAssembly.Instance(module, { env: { memory } });
		const address = 65536;
		const count = 67;
		const words = new Uint32Array(memory.buffer);
		const reset = () => {
			for (let index = 0; index < count; index++) words[address / 4 + index] = index + 1;
		};
		let rounds = 65536;
		for (;;) {
			reset();
			const begin = performance.now();
			(owner.exports.program as CallableFunction)(address, count, rounds);
			const wallMs = performance.now() - begin;
			raw.push({ phase: 'calibration', width: 0, rounds, count, wallMs });
			if (wallMs >= 50 || rounds >= 2097152) break;
			rounds *= 2;
		}
		const expected = new Uint8Array(bytes);
		for (let iteration = -1; iteration < 3; iteration++) {
			const order = [0, ...widths];
			const offset = (iteration + 1) % order.length;
			for (const width of [...order.slice(offset), ...order.slice(0, offset)]) {
				ensure(performance.now() - started < 65000, 'probe time budget');
				reset();
				const begin = performance.now();
				const report =
					width === 0
						? {
								values: [
									(owner.exports.program as CallableFunction)(
										address,
										count,
										rounds
									)
								],
								mode: 'serial',
								regions: 1,
								workers: 0
							}
						: await pools[widths.indexOf(width)]!.run('program', [
								address,
								count,
								rounds
							]);
				const wallMs = performance.now() - begin;
				for (let index = 0; index < bytes.length; index++)
					if (bytes[index] !== expected[index])
						throw new Error(`memory mismatch at ${index}`);
				ensure(
					report.values.length === 1 && report.values[0] === undefined,
					'native return identity'
				);
				ensure(report.mode === (width > 1 ? 'native-shared' : 'serial'), 'execution mode');
				raw.push({
					phase: iteration < 0 ? 'warmup' : 'measured',
					iteration,
					width,
					count,
					rounds,
					wallMs,
					regions: report.regions,
					workers: report.workers,
					mode: report.mode,
					memoryBytes: bytes.length,
					fullMemoryExact: true,
					returnExact: true
				});
			}
		}
		memory.grow(1);
		const fresh = new Uint32Array(memory.buffer);
		fresh[bytes.length / 4] = 17;
		fresh[bytes.length / 4 + 1] = 23;
		const growth = await pools[1]!.run('program', [bytes.length, 2, 31]);
		ensure(growth.mode === 'native-shared', 'grown shared arena execution');
		result.growth = {
			oldBytes: bytes.length,
			newBytes: memory.buffer.byteLength,
			mode: growth.mode
		};
		result.coverage = pools[3]!.inspect('program');
		result.initialBytes = bytes.length;
		result.count = count;
		result.rounds = rounds;
		result.samplesPerWidth = 3;
		result.aggregateCpuMeasured = false;
		result.passed = true;
	} catch (error) {
		result.passed = false;
		result.error = String(error instanceof Error ? error.stack : error);
	} finally {
		await Promise.all(pools.map((pool) => pool.close()));
		result.elapsedMs = performance.now() - started;
		result.closedPools = pools.length;
	}
	return result;
}

(globalThis as any).runBrowserExtractionProbe = runBrowserExtractionProbe;
