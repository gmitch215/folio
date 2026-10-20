type Message = Record<string, any>;

export function browserLane() {
	const scope = self as unknown as {
		onmessage: ((event: { data: Message }) => void) | null;
		postMessage(value: unknown): void;
	};
	let memory: WebAssembly.Memory | undefined;
	let oldView: Uint8Array | undefined;
	let instance: any;
	let compute: any;
	let copy: Uint32Array | undefined;
	const id = crypto.randomUUID();
	scope.onmessage = ({ data: message }) => {
		try {
			let result: Message;
			if (message.action === 'attach') {
				memory = message.memory as WebAssembly.Memory;
				oldView = new Uint8Array(memory.buffer);
				instance = new WebAssembly.Instance(message.module, { env: { memory } });
				if (message.computeModule) {
					compute = new WebAssembly.Instance(message.computeModule, { env: { memory } });
				}
				let sum = 0;
				for (let at = 0; at < oldView.length; at += 4096) sum += oldView[at]!;
				result = {
					id,
					sum,
					length: oldView.length,
					shared: memory.buffer instanceof SharedArrayBuffer
				};
			} else if (message.action === 'mutate') {
				for (let i = 0; i < 10000; i++) instance.exports.add(0, 1);
				const before = instance.exports.read(message.address);
				instance.exports.write(message.address, message.value);
				new Uint32Array(memory!.buffer)[message.jsAddress / 4] = message.value + 1000;
				result = { id, before, value: instance.exports.read(message.address) };
			} else if (message.action === 'read') {
				result = { id, value: instance.exports.read(message.address) };
			} else if (message.action === 'write') {
				instance.exports.write(message.address, message.value);
				result = { id, value: instance.exports.read(message.address) };
			} else if (message.action === 'growth') {
				const view = new Uint8Array(memory!.buffer);
				let zero = true;
				for (let at = message.address; at < view.length; at++)
					if (view[at] !== 0) zero = false;
				result = { id, zero, oldLength: oldView!.length, newLength: view.length };
			} else if (message.action === 'copy') {
				copy = new Uint32Array(message.buffer);
				const before = copy[0];
				copy[0] = message.value;
				result = { id, before, after: copy[0], length: copy.byteLength };
			} else if (message.action === 'copy-read') {
				result = { id, value: copy![0] };
			} else if (message.action === 'compute') {
				const start = performance.now();
				compute.exports.program(message.address, message.count, message.rounds);
				result = { id, wallMs: performance.now() - start };
			} else if (message.action === 'create') {
				const created = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
				new Uint32Array(created.buffer)[0] = 47;
				result = { id, memory: created };
			} else throw new Error('Unknown browser lane action');
			scope.postMessage({ sequence: message.sequence, result });
		} catch (error: any) {
			scope.postMessage({ sequence: message.sequence, error: String(error.stack ?? error) });
		}
	};
}

export async function runBrowserProbe() {
	const started = performance.now();
	const workers: Worker[] = [];
	const raw: Message[] = [];
	function ensure(condition: unknown, message: string): asserts condition {
		if (!condition) throw new Error(message);
	}
	const checkTime = () =>
		ensure(performance.now() - started < 65000, 'Browser probe time budget');
	const request = (worker: Worker, message: Message) =>
		new Promise<any>((resolve, reject) => {
			const sequence = crypto.randomUUID();
			const cleanup = () => {
				clearTimeout(timer);
				worker.removeEventListener('message', done as EventListener);
				worker.removeEventListener('error', fail as EventListener);
				worker.removeEventListener('messageerror', fail as EventListener);
			};
			const fail = (error: { message?: string }) => {
				cleanup();
				reject(new Error(error.message ?? 'Browser worker message error'));
			};
			const done = ({ data }: MessageEvent) => {
				if (data.sequence !== sequence) return;
				cleanup();
				if (data.error) reject(new Error(data.error));
				else resolve(data.result);
			};
			const timer = setTimeout(() => fail({ message: 'Browser worker timeout' }), 12000);
			worker.addEventListener('message', done);
			worker.addEventListener('error', fail as EventListener);
			worker.addEventListener('messageerror', fail as EventListener);
			try {
				worker.postMessage({ ...message, sequence });
			} catch (error: any) {
				fail(error);
			}
		});
	const runtime = WebAssembly as any;
	const result: Message = {
		kind: 'browser-native-sharing',
		userAgent: navigator.userAgent,
		hardwareConcurrency: navigator.hardwareConcurrency,
		crossOriginIsolated,
		jspi: typeof runtime.Suspending === 'function' && typeof runtime.promising === 'function',
		sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
		raw
	};
	try {
		ensure(
			result.crossOriginIsolated && result.sharedArrayBuffer,
			'Cross-origin isolation/SAB unavailable'
		);
		const [module, computeModule] = (await Promise.all(
			['/sharing.wasm', '/fixture.wasm'].map(async (path) => {
				const response = await fetch(path);
				ensure(response.ok, `Wasm asset failed: ${path}`);
				return WebAssembly.compile(await response.arrayBuffer());
			})
		)) as [WebAssembly.Module, WebAssembly.Module];
		const memory = new WebAssembly.Memory({ initial: 4096, maximum: 8192, shared: true });
		const bytes = new Uint8Array(memory.buffer);
		for (let at = 0; at < bytes.length; at += 4096) bytes[at] = 7;
		const originalBytes = bytes.length;
		for (let index = 0; index < 8; index++) workers.push(new Worker('/lane.js'));
		const attached = await Promise.all(
			workers.map((worker) =>
				request(worker, { action: 'attach', memory, module, computeModule })
			)
		);
		for (const lane of attached) {
			ensure(lane.shared && lane.length === originalBytes, 'Shared backing attachment');
			ensure(lane.sum === (originalBytes / 4096) * 7, 'Full arena residency checksum');
		}
		ensure(
			new Set(attached.map((lane) => lane.id)).size === 8,
			'Distinct browser execution agents'
		);
		result.attached = attached;
		Atomics.store(new Int32Array(memory.buffer), 0, 0);
		const words = new Uint32Array(memory.buffer);
		for (let index = 0; index < 4; index++) words[32 + index] = index + 20;
		const mutations = await Promise.all(
			workers.slice(0, 4).map((worker, index) =>
				request(worker, {
					action: 'mutate',
					address: 128 + index * 4,
					jsAddress: 256 + index * 4,
					value: 100 + index
				})
			)
		);
		ensure(
			Atomics.load(new Int32Array(memory.buffer), 0) === 40000,
			'Wasm atomic accumulation'
		);
		for (let index = 0; index < 4; index++) {
			ensure(mutations[index].before === index + 20, 'Parent to worker native alias');
			ensure(words[32 + index] === index + 100, 'Worker to parent native alias');
			ensure(words[64 + index] === index + 1100, 'Worker JS to parent alias');
		}
		const crossReads = await Promise.all(
			workers
				.slice(0, 4)
				.map((worker, index) =>
					request(worker, { action: 'read', address: 128 + ((index + 1) % 4) * 4 })
				)
		);
		crossReads.forEach((read, index) =>
			ensure(read.value === 100 + ((index + 1) % 4), 'Worker to worker native alias')
		);
		result.alias = { atomics: 40000, mutations, crossReads, passed: true };
		const copied = new Uint32Array(16384);
		copied[0] = 91;
		const copies = await Promise.all(
			workers
				.slice(0, 4)
				.map((worker, index) =>
					request(worker, { action: 'copy', buffer: copied.buffer, value: 200 + index })
				)
		);
		ensure(copied[0] === 91 && copied.byteLength === 65536, 'Copied buffer parent isolation');
		const copyReads = await Promise.all(
			workers.slice(0, 4).map((worker) => request(worker, { action: 'copy-read' }))
		);
		copies.forEach((copy, index) => {
			ensure(
				copy.before === 91 && copy.after === 200 + index,
				'Copied buffer worker mutation'
			);
			ensure(copyReads[index].value === 200 + index, 'Copied buffer peer isolation');
		});
		result.copyControl = { parent: copied[0], copies, copyReads, passed: true };
		memory.grow(1);
		const growth = await Promise.all(
			workers
				.slice(0, 4)
				.map((worker, index) =>
					request(worker, { action: 'growth', address: originalBytes, index })
				)
		);
		growth.forEach((item) =>
			ensure(
				item.zero &&
					item.oldLength === originalBytes &&
					item.newLength === originalBytes + 65536,
				'Growth visibility and zero fill'
			)
		);
		await Promise.all(
			workers.slice(0, 4).map((worker, index) =>
				request(worker, {
					action: 'write',
					address: originalBytes + index * 4,
					value: 700 + index
				})
			)
		);
		const fresh = new Uint32Array(memory.buffer);
		for (let index = 0; index < 4; index++) {
			ensure(fresh[originalBytes / 4 + index] === 700 + index, 'Grown-page native alias');
		}
		result.growth = { observations: growth, passed: true };
		checkTime();
		const owner: any = new WebAssembly.Instance(computeModule, { env: { memory } });
		const address = 65536;
		const count = 64;
		const reset = () => {
			for (let i = 0; i < count; i++) fresh[address / 4 + i] = i + 1;
		};
		let rounds = 65536;
		for (;;) {
			reset();
			const before = performance.now();
			owner.exports.program(address, count, rounds);
			const elapsedMs = performance.now() - before;
			raw.push({ phase: 'calibration', width: 0, rounds, elapsedMs });
			if (elapsedMs >= 80 || rounds === 2097152) break;
			rounds *= 2;
		}
		const expected = fresh.slice(address / 4, address / 4 + count);
		for (let iteration = -1; iteration < 3; iteration++) {
			const order = [0, 1, 2, 4, 8];
			const offset = (iteration + 1) % order.length;
			for (const width of [...order.slice(offset), ...order.slice(0, offset)]) {
				checkTime();
				reset();
				const before = performance.now();
				let lanes: unknown[] = [];
				if (width === 0) owner.exports.program(address, count, rounds);
				else {
					lanes = await Promise.all(
						workers.slice(0, width).map((worker, index) =>
							request(worker, {
								action: 'compute',
								address: address + index * (count / width) * 4,
								count: count / width,
								rounds
							})
						)
					);
				}
				const wallMs = performance.now() - before;
				for (let i = 0; i < count; i++) {
					ensure(fresh[address / 4 + i] === expected[i], 'CPU arm output equality');
				}
				raw.push({
					phase: iteration < 0 ? 'warmup' : 'measured',
					iteration,
					width,
					rounds,
					count,
					wallMs,
					lanes,
					outputExact: true
				});
			}
		}
		result.cpu = {
			rounds,
			count,
			samplesPerWidth: 3,
			outputWords: [...expected],
			aggregateCpuMeasured: false
		};
		const creator = new Worker('/lane.js');
		workers.push(creator);
		const created = await request(creator, { action: 'create' });
		creator.terminate();
		ensure(new Uint32Array(created.memory.buffer)[0] === 47, 'Creator wrapper lifetime');
		const survivor = await request(workers[0]!, {
			action: 'attach',
			memory: created.memory,
			module
		});
		const lifetimeMutation = await request(workers[0]!, {
			action: 'mutate',
			address: 16,
			jsAddress: 32,
			value: 999
		});
		ensure(
			new Uint32Array(created.memory.buffer)[4] === 999,
			'Creator termination survivor alias'
		);
		result.creatorTermination = {
			survivor,
			lifetimeMutation,
			terminationRequested: true,
			passed: true
		};
		result.initialBytes = originalBytes;
		result.finalBytes = memory.buffer.byteLength;
		result.elapsedMs = performance.now() - started;
		result.passed = true;
		return result;
	} catch (error: any) {
		return {
			...result,
			passed: false,
			error: String(error.stack ?? error),
			elapsedMs: performance.now() - started
		};
	} finally {
		for (const worker of workers) worker.terminate();
	}
}
