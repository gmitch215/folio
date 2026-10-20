import { DurableObject } from 'cloudflare:workers';
import type { FrameIdentity } from '../../src/frames.ts';
import { decodeFrame } from '../../src/frames.ts';
import type { ManagedLaneTransport } from '../../src/managed.ts';
import { FolioLane, ManagedFolio } from '../../src/managed.ts';
import artifact, { metadata } from './artifact.ts';

interface Env {
	LANES: DurableObjectNamespace;
	OWNERS: DurableObjectNamespace;
	PROBE_TOKEN?: string;
}

// stubs cross the RPC boundary with raw frames, which the typed RPC surface would refuse
type Stub = any;
type Mode = 'rpc' | 'fetch' | 'stream' | 'websocket';
type Pending = {
	resolve: (frame: Uint8Array) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type Header = FrameIdentity & { calls: unknown[] };

let moduleId: string | undefined;
const identity = () => (moduleId ??= crypto.randomUUID());
function ensure(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const maximumFrame = 2 * 1048576;
const maximumBody = async (response: Request | Response) => {
	const bytes = new Uint8Array(await response.arrayBuffer());
	ensure(bytes.length <= maximumFrame, 'Frame exceeds probe limit');
	return bytes;
};
const stream = (bytes: Uint8Array) =>
	new ReadableStream({
		start(controller) {
			for (let at = 0; at < bytes.length; at += 65536) {
				controller.enqueue(bytes.subarray(at, at + 65536));
			}
			controller.close();
		}
	});

export class ManagedLane extends DurableObject<Env> {
	state: DurableObjectState;
	executor?: FolioLane;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.state = state;
	}

	info() {
		return { isolate: identity(), object: this.state.id.toString() };
	}

	execute(bytes: Uint8Array) {
		ensure(bytes.byteLength <= maximumFrame, 'Frame exceeds probe limit');
		this.executor ??= new FolioLane(artifact.transactional, {
			initial: artifact.control.initial,
			maximum: artifact.control.maximum,
			maximumMemoryBytes: 131072,
			maximumFrameBytes: maximumFrame
		});
		const { header } = decodeFrame<Header>(bytes, maximumFrame);
		const response = this.executor.execute(bytes);
		console.log(
			JSON.stringify({
				probe: 'folio-managed-lane',
				...this.info(),
				session: header.session,
				epoch: header.epoch,
				sequence: header.sequence,
				calls: header.calls.length,
				requestBytes: bytes.length,
				responseBytes: response.length
			})
		);
		return response;
	}

	retire() {
		this.executor?.close();
		this.executor = undefined;
	}

	override async fetch(request: Request) {
		if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];
			server.accept();
			server.binaryType = 'arraybuffer';
			server.addEventListener('message', (event) => {
				try {
					ensure(typeof event.data !== 'string', 'Binary frame required');
					server.send(this.execute(new Uint8Array(event.data as ArrayBuffer)));
				} catch {
					server.close(1011, 'Lane execution failed');
				}
			});
			server.addEventListener('close', () => this.retire());
			return new Response(null, { status: 101, webSocket: client });
		}
		const bytes = await maximumBody(request);
		const response = this.execute(bytes);
		return new Response(
			new URL(request.url).pathname === '/stream' ? stream(response) : (response as BodyInit),
			{ headers: { 'content-type': 'application/octet-stream' } }
		);
	}
}

async function socketLane(stub: Stub, observe: (frame: Uint8Array) => void) {
	const response = await stub.fetch('https://lane/ws', { headers: { upgrade: 'websocket' } });
	ensure(response.status === 101 && response.webSocket, 'WebSocket upgrade failed');
	const socket: WebSocket = response.webSocket;
	socket.accept();
	socket.binaryType = 'arraybuffer';
	let pending: Pending | undefined;
	socket.addEventListener('message', (event) => {
		if (!pending) {
			socket.close(1002, 'Unexpected lane response');
			return;
		}
		const active = pending;
		pending = undefined;
		clearTimeout(active.timer);
		typeof event.data === 'string'
			? active.reject(new Error('Binary response required'))
			: active.resolve(new Uint8Array(event.data));
	});
	const stopped = () => {
		if (pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Lane socket closed'));
			pending = undefined;
		}
	};
	socket.addEventListener('close', stopped);
	socket.addEventListener('error', stopped);
	return {
		execute(frame: Uint8Array) {
			observe(frame);
			if (pending) return Promise.reject(new Error('Concurrent socket lane operation'));
			return new Promise<Uint8Array>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending = undefined;
					socket.close(1011, 'Lane timeout');
					reject(new Error('Lane timeout'));
				}, 15000);
				pending = { resolve, reject, timer };
				try {
					socket.send(frame);
				} catch (error) {
					clearTimeout(timer);
					pending = undefined;
					reject(error);
				}
			});
		},
		async close() {
			stopped();
			socket.close(1000, 'Probe complete');
			await stub.retire();
		}
	};
}

export class ManagedOwner extends DurableObject<Env> {
	state: DurableObjectState;
	rounds = 2097152;
	count = 64;
	pool?: ManagedFolio;
	frames: { session: string; epoch: number; sequence: number }[] = [];
	laneIdentities: unknown[] = [];
	expectedValue: unknown;
	expected = new Uint8Array(0);
	mode: Mode = 'rpc';
	width = 0;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.state = state;
	}

	async prepare(mode: Mode, width: number, nonce: string) {
		await this.pool?.close();
		const stubs: Stub[] = Array.from({ length: width }, (_, index) =>
			this.env.LANES.get(this.env.LANES.idFromName(`${nonce}-${index}`))
		);
		this.laneIdentities = await Promise.all(stubs.map((stub) => stub.info()));
		const observe = (frame: Uint8Array) => {
			const { header } = decodeFrame<Header>(frame, maximumFrame);
			this.frames.push({
				session: header.session,
				epoch: header.epoch,
				sequence: header.sequence
			});
		};
		const transports: ManagedLaneTransport[] = await Promise.all(
			stubs.map(async (stub): Promise<ManagedLaneTransport> => {
				if (mode === 'websocket') return socketLane(stub, observe);
				return {
					execute: async (frame) => {
						observe(frame);
						if (mode === 'rpc') return stub.execute(frame);
						const response = await stub.fetch(`https://lane/${mode}`, {
							method: 'POST',
							body: mode === 'stream' ? stream(frame) : frame,
							signal: AbortSignal.timeout(15000)
						});
						ensure(response.ok, 'Lane fetch failed');
						return maximumBody(response);
					},
					close: async () => {
						await stub.retire();
					}
				};
			})
		);
		this.pool = new ManagedFolio(artifact, { lanes: transports });
		const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
		const native = new WebAssembly.Instance(artifact.original, { env: { memory } });
		this.initialize(memory);
		this.expectedValue = (native.exports.main as CallableFunction)(
			1024,
			this.count,
			this.rounds
		);
		this.expected = Uint8Array.from(new Uint8Array(memory.buffer));
		this.mode = mode;
		this.width = width;
		return { laneIdentities: this.laneIdentities, owner: identity(), mode, width };
	}

	initialize(memory: WebAssembly.Memory) {
		new Uint8Array(memory.buffer).fill(0);
		const words = new Uint32Array(memory.buffer, 1024, this.count);
		for (let i = 0; i < words.length; i++) words[i] = Math.imul(i + 1, 2654435761) >>> 0;
	}

	async runOnce(serial: boolean, phase: string, iteration: number) {
		const pool = this.pool;
		ensure(pool, 'Prepare owner first');
		this.frames = [];
		this.initialize(pool.memory);
		const report = await pool.run('main', [1024, this.count, this.rounds], {
			parallel: serial ? 'off' : 'auto'
		});
		ensure(report.values[0] === this.expectedValue, 'Scalar result differs');
		const actual = new Uint8Array(pool.memory.buffer);
		ensure(actual.length === this.expected.length, 'Arena size differs');
		for (let i = 0; i < actual.length; i++) {
			ensure(actual[i] === this.expected[i], `Memory differs at ${i}`);
		}
		if (!serial) {
			ensure(
				report.regions === 64 && report.workers === this.width,
				'Automatic extraction missing'
			);
			ensure(
				report.replayed === 0 && report.fallbacks === 0 && report.transportFallbacks === 0,
				`Unexpected fallback: ${JSON.stringify(pool.diagnostics)}`
			);
		}
		console.log(
			JSON.stringify({
				probe: 'folio-managed-owner',
				owner: identity(),
				mode: this.mode,
				width: this.width,
				serial,
				phase,
				iteration,
				exact: true
			})
		);
		return {
			report,
			exact: true,
			checkedBytes: actual.length,
			scalar: report.values[0],
			mode: serial ? 'serial' : this.mode,
			width: serial ? 0 : this.width,
			identities: this.laneIdentities,
			dispatches: this.frames
		};
	}

	async close() {
		await this.pool?.close();
		this.pool = undefined;
		return { closed: true };
	}

	async runPrepared(
		mode: Mode,
		width: number,
		nonce: string,
		serial: boolean,
		phase: string,
		iteration: number
	) {
		await this.prepare(mode, width, nonce);
		try {
			return await this.runOnce(serial, phase, iteration);
		} finally {
			await this.close();
		}
	}
}

export default {
	async fetch(request, env) {
		if (
			!env.PROBE_TOKEN ||
			request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`
		) {
			return new Response('Unauthorized', { status: 401 });
		}
		if (new URL(request.url).pathname !== '/run' || request.method !== 'POST') {
			return new Response('Not found', { status: 404 });
		}
		const nonce = crypto.randomUUID();
		const owner: Stub = env.OWNERS.get(env.OWNERS.idFromName(nonce));
		const rows: Record<string, unknown>[] = [];
		const phase = (iteration: number) => (iteration < 0 ? 'warmup' : 'measured');
		try {
			for (let iteration = -1; iteration < 2; iteration++) {
				const began = performance.now();
				const row = await owner.runPrepared(
					'rpc',
					2,
					nonce,
					true,
					phase(iteration),
					iteration
				);
				rows.push({
					...row,
					wallMs: performance.now() - began,
					iteration,
					phase: phase(iteration)
				});
			}
			for (const mode of ['rpc', 'fetch', 'stream', 'websocket']) {
				for (const width of [2, 4, 8]) {
					for (let iteration = -1; iteration < 2; iteration++) {
						const began = performance.now();
						const row = await owner.runPrepared(
							mode,
							width,
							nonce,
							false,
							phase(iteration),
							iteration
						);
						rows.push({
							...row,
							wallMs: performance.now() - began,
							iteration,
							phase: phase(iteration)
						});
					}
				}
			}
			return Response.json({
				passed: true,
				nonce,
				sourceSha256: metadata.sourceSha256,
				jspi:
					typeof (WebAssembly as any).Suspending === 'function' &&
					typeof (WebAssembly as any).promising === 'function',
				count: 64,
				rounds: 2097152,
				rows,
				discardedSamples: 0,
				preparationIncludedInWallTime: true
			});
		} catch (error: any) {
			return Response.json(
				{ passed: false, nonce, error: String(error.stack ?? error), rows },
				{ status: 502 }
			);
		} finally {
			await owner.close();
		}
	}
} satisfies ExportedHandler<Env>;
