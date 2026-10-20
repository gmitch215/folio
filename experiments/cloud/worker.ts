import { DurableObject } from 'cloudflare:workers';
import * as threads from 'node:worker_threads';
import sharingModule from '../../build/sharing.wasm';

interface Env {
	LANES: DurableObjectNamespace;
	COORDINATORS: DurableObjectNamespace;
}

// stubs carry buffers and ports that the typed RPC surface refuses, which is what the probe tests
type Stub = any;
type Job = {
	nonce: string;
	lanes: number;
	round: number;
	phase: string;
	start: number;
	count: number;
	rounds: number;
};

let isolateId: string | undefined;
const seenObjects = new Set<string>();
const moduleWords = new Map<string, unknown>();

function identity(objectId: string | null = null) {
	isolateId ??= crypto.randomUUID();
	return { isolateId, objectId, moduleObjects: [...seenObjects] };
}

function failure(error: any) {
	return { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
}

async function attempt<T>(operation: () => T | Promise<T>) {
	try {
		return { ok: true as const, value: await operation() };
	} catch (error) {
		return { ok: false as const, error: failure(error) };
	}
}

function marker(input: any): any {
	return input instanceof WebAssembly.Memory
		? new Uint32Array(input.buffer)
		: input instanceof ArrayBuffer || input instanceof SharedArrayBuffer
			? new Uint32Array(input)
			: input;
}

function sharedMemory() {
	return new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
}

function cloneProbe(value: any) {
	const source = marker(value);
	source[0] = 17;
	const clone = structuredClone(value);
	const copied = marker(clone);
	copied[0] = 29;
	source[1] = 43;
	return {
		cloneType: Object.prototype.toString.call(clone),
		separateWrapper: clone !== value,
		forwardVisible: source[0] === 29,
		reverseVisible: copied[1] === 43
	};
}

async function channelProbe() {
	const channel = new MessageChannel();
	const buffer = new SharedArrayBuffer(16);
	const source = new Int32Array(buffer);
	source[0] = 17;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const received = new Promise((resolve, reject) => {
			timeout = setTimeout(() => reject(new Error('Local channel timed out')), 1000);
			channel.port2.onmessage = ({ data }: MessageEvent) => {
				const destination = new Int32Array(data);
				Atomics.add(destination, 0, 12);
				resolve({ ...identity(), sameIsolate: true, sourceSeesWrite: source[0] === 29 });
			};
			(channel.port2 as any).onmessageerror = () =>
				reject(new Error('Local channel clone failed'));
			channel.port2.start();
		});
		channel.port1.postMessage(buffer);
		return await received;
	} finally {
		clearTimeout(timeout);
		channel.port1.close();
		channel.port2.close();
	}
}

async function capabilities() {
	const results: Record<string, unknown> = {
		...identity(),
		worker: typeof (globalThis as any).Worker
	};
	results.navigatorConcurrency = (globalThis as any).navigator?.hardwareConcurrency ?? null;
	results.sharedBuffer = await attempt(() => new SharedArrayBuffer(16).byteLength);
	results.sharedMemory = await attempt(() => sharedMemory().buffer instanceof SharedArrayBuffer);
	results.cloneBytes = await attempt(() => cloneProbe(new ArrayBuffer(16)));
	results.cloneSab = await attempt(() => cloneProbe(new SharedArrayBuffer(16)));
	results.cloneMemory = await attempt(() => cloneProbe(sharedMemory()));
	results.localChannelSab = await attempt(channelProbe);
	results.bundledWasmAtomics = await attempt(() => {
		const memory = sharedMemory();
		const exports: any = new WebAssembly.Instance(sharingModule, { env: { memory } }).exports;
		exports.write(4096, 17);
		const before = exports.add(4096, 12);
		return {
			before,
			after: exports.read(4096),
			valid: before === 17 && exports.read(4096) === 29
		};
	});
	results.atomicsWait = await attempt(() =>
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 0)
	);
	results.nodeWorkerThreads = {
		isMainThread: threads.isMainThread,
		threadId: threads.threadId,
		worker: await attempt(() => new threads.Worker('0', { eval: true }).terminate()),
		broadcastChannel: await attempt(() => {
			const channel = new threads.BroadcastChannel('folio-probe');
			channel.close();
			return true;
		})
	};
	return results;
}

function kernel(start: number, count: number, rounds: number) {
	let sum = 0;
	for (let i = start; i < start + count; i++) {
		let value = (i + 0x9e3779b9) | 0;
		for (let j = 0; j < rounds; j++) {
			value ^= value << 13;
			value ^= value >>> 17;
			value ^= value << 5;
		}
		sum = (sum + (value >>> 0)) >>> 0;
	}
	return sum;
}

export class Lane extends DurableObject<Env> {
	objectId: string;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.objectId = ctx.id.toString();
		if (seenObjects.size < 32) seenObjects.add(this.objectId);
	}

	identity() {
		return identity(this.objectId);
	}

	mutate(value: any, echo = true) {
		const view = marker(value);
		const before = view[0];
		view[0] = 29;
		return { ...identity(this.objectId), before, after: view[0], echoed: echo ? value : null };
	}

	createShared(kind: string) {
		return kind === 'memory' ? sharedMemory() : new SharedArrayBuffer(16);
	}

	acceptPort(port: MessagePort) {
		port.postMessage('folio-port-arrived');
		return identity(this.objectId);
	}

	moduleProbe(key: string, value: unknown) {
		if (!moduleWords.has(key) && moduleWords.size >= 32)
			throw new Error('Module probe capacity');
		const old = moduleWords.get(key) ?? null;
		if (value !== null) moduleWords.set(key, value);
		return { ...identity(this.objectId), old, value: moduleWords.get(key) ?? null };
	}

	work(job: Job) {
		const { nonce, lanes, round, phase, start, count, rounds } = job;
		if (
			!Number.isInteger(start) ||
			start < 0 ||
			!Number.isInteger(count) ||
			count < 1 ||
			start + count > 1048576 ||
			!Number.isInteger(rounds) ||
			rounds < 1 ||
			rounds > 256
		) {
			throw new Error('Work bounds exceeded');
		}
		const checksum = kernel(start, count, rounds);
		const modulePreviousObject = moduleWords.get(nonce) ?? null;
		if (moduleWords.has(nonce) || moduleWords.size < 32) moduleWords.set(nonce, this.objectId);
		const result = {
			...identity(this.objectId),
			nonce,
			lanes,
			round,
			phase,
			start,
			count,
			rounds,
			checksum,
			modulePreviousObject
		};
		console.log(JSON.stringify({ probe: 'folio-cpu-lane', ...result }));
		return result;
	}
}

export class Coordinator extends DurableObject<Env> {
	async run(input: { nonce: unknown; count?: number; rounds?: number }) {
		const nonce = validNonce(input.nonce);
		const count = input.count ?? 524288;
		const rounds = input.rounds ?? 128;
		if (
			!Number.isInteger(count) ||
			count < 8 ||
			count > 1048576 ||
			!Number.isInteger(rounds) ||
			rounds < 1 ||
			rounds > 256
		) {
			throw new Error('CPU bounds exceeded');
		}
		const stubs: Stub[] = Array.from({ length: 8 }, (_, i) =>
			this.env.LANES.get(this.env.LANES.idFromName(`${nonce}-cpu-${i}`))
		);
		const rows: Record<string, any>[] = [];
		let expected: number | undefined;
		for (let round = 0; round < 3; round++) {
			const order = round % 2 ? [8, 4, 2, 1] : [1, 2, 4, 8];
			for (const lanes of order) {
				const started = performance.now();
				const parts: Record<string, any>[] = await Promise.all(
					stubs.slice(0, lanes).map((stub, i) => {
						const start = Math.floor((count * i) / lanes);
						return stub.work({
							nonce,
							lanes,
							round,
							phase: round ? 'measure' : 'warmup',
							start,
							count: Math.floor((count * (i + 1)) / lanes) - start,
							rounds
						});
					})
				);
				const wallMs = performance.now() - started;
				const checksum = parts.reduce((sum, part) => (sum + part.checksum) >>> 0, 0);
				expected ??= checksum;
				const row = {
					lanes,
					round,
					phase: round ? 'measure' : 'warmup',
					wallMs,
					checksum,
					exact: checksum === expected,
					distinctIsolates: new Set(parts.map((part) => part.isolateId)).size,
					parts
				};
				rows.push(row);
				console.log(JSON.stringify({ probe: 'folio-cpu-coordinator', nonce, ...row }));
			}
		}
		return {
			...identity(this.ctx.id.toString()),
			nonce,
			count,
			rounds,
			expected,
			exact: rows.every((row) => row.exact),
			laneInvocations: 45,
			rows
		};
	}
}

function validNonce(value: unknown): string {
	if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(value)) {
		throw new Error('Nonce must contain 1 to 48 letters, digits, underscores or hyphens');
	}
	return value;
}

async function rpcProbe(env: Env, nonce: string) {
	const stub: Stub = env.LANES.get(env.LANES.idFromName(`${nonce}-rpc`));
	const result: Record<string, any> = { caller: identity(), callee: await stub.identity() };
	result.distinctIsolates = result.caller.isolateId !== result.callee.isolateId;
	const plain = new Uint32Array(4);
	plain[0] = 17;
	result.bytes = await attempt(async () => {
		const response = await stub.mutate(plain);
		return {
			sourceAfter: plain[0],
			remoteBefore: response.before,
			remoteAfter: response.after,
			echoedAfter: response.echoed[0],
			callerUnaffected: plain[0] === 17,
			remote: { isolateId: response.isolateId, objectId: response.objectId }
		};
	});
	for (const [name, value] of [
		['sab', new SharedArrayBuffer(16)],
		['sharedMemory', sharedMemory()],
		['ordinaryMemory', new WebAssembly.Memory({ initial: 2, maximum: 2 })]
	] as const) {
		marker(value)[0] = 17;
		result[name] = await attempt(async () => {
			const response = await stub.mutate(value, false);
			return {
				sourceAfter: marker(value)[0],
				remoteBefore: response.before,
				remoteAfter: response.after,
				writeVisible: marker(value)[0] === 29,
				remote: response.isolateId
			};
		});
		result[name].sourceAfterAttempt = marker(value)[0];
	}
	result.returnSab = await attempt(async () => (await stub.createShared('sab')).byteLength);
	result.returnSharedMemory = await attempt(
		async () => (await stub.createShared('memory')).buffer.byteLength
	);
	const channel = new MessageChannel();
	try {
		result.rpcMessagePort = await attempt(() => stub.acceptPort(channel.port2));
	} finally {
		channel.port1.close();
		channel.port2.close();
	}
	return { ...result, rpcInvocationsUpperBound: 8 };
}

export default {
	async fetch(request, env) {
		try {
			const url = new URL(request.url);
			if (request.method === 'GET' && url.pathname === '/capabilities') {
				return Response.json(await capabilities());
			}
			if (request.method === 'POST' && url.pathname === '/rpc') {
				const { nonce } = (await request.json()) as { nonce: unknown };
				return Response.json(await rpcProbe(env, validNonce(nonce)));
			}
			if (request.method === 'POST' && url.pathname === '/cpu') {
				const input = (await request.json()) as {
					nonce: unknown;
					count?: number;
					rounds?: number;
				};
				validNonce(input.nonce);
				const stub: Stub = env.COORDINATORS.get(
					env.COORDINATORS.idFromName(input.nonce as string)
				);
				return Response.json(await stub.run(input));
			}
			return Response.json({ error: 'Unknown probe route' }, { status: 404 });
		} catch (error) {
			return Response.json({ error: failure(error) }, { status: 400 });
		}
	}
} satisfies ExportedHandler<Env>;
