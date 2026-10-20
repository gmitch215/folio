import type { FolioOptions, ProgramInput, RunOptions } from './node.ts';
import { Folio } from './node.ts';
import { decodeBytes, decodeValue, encodeBytes, encodeValue } from './remote.ts';

/** A trusted program registered under an artifact id. */
export interface HostArtifact {
	/** The program or prepared plan every session of this artifact runs. */
	program: ProgramInput;
	/** Explicit allowlist; a registered module does not expose every export. */
	exports: readonly string[];
	/**
	 * Trusted bindings. The request cannot provide executable host code. Returns pool options such
	 * as the memory and imports, and a `dispose` called once after the group's workers join.
	 */
	create?: () =>
		| Promise<{ options?: FolioOptions; dispose?: () => void | Promise<void> }>
		| { options?: FolioOptions; dispose?: () => void | Promise<void> };
}

/** Admission and transport bounds. Defaults are conservative for a shared host. */
export interface HostLimits {
	/** Groups open at once; further opens are refused. */
	liveGroups: number;
	/** Workers a single session may request. */
	workersPerGroup: number;
	/** Initial accessible canonical backing admission; trusted bindings enforce growth maxima. */
	memoryBytesPerGroup: number;
	/** Largest request body. */
	requestBytes: number;
	/** Largest response body. */
	responseBytes: number;
	/** Largest single memory read. */
	readBytes: number;
	/** Largest single memory write. */
	writeBytes: number;
	/** Most arguments in one call. */
	argumentsPerCall: number;
	/** Idle time before a session expires; active operations postpone expiry. */
	idleMilliseconds: number;
	/** Sessions whose last response the host keeps for `retryPending()`. */
	retainedSessions: number;
}

interface Session {
	pool: Folio;
	artifact: HostArtifact;
	dispose?: () => void | Promise<void>;
	sequence: number;
	last?: { body: string; response: string; status: number };
	tail: Promise<unknown>;
	operations: number;
	touched: number;
	closed: boolean;
	released: boolean;
	closing?: Promise<void>;
}

class ProtocolError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

const defaults: HostLimits = {
	liveGroups: 4,
	workersPerGroup: 8,
	memoryBytesPerGroup: 64 * 1024 * 1024,
	requestBytes: 2 * 1024 * 1024,
	responseBytes: 2 * 1024 * 1024,
	readBytes: 512 * 1024,
	writeBytes: 512 * 1024,
	argumentsPerCall: 64,
	idleMilliseconds: 5 * 60_000,
	retainedSessions: 64
};

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
		throw new ProtocolError('invalid integer or exceeded admission limit');
	return value;
}

/** Same-process execution behind an authenticated fetch handler, with no public code upload. */
export class FolioHost {
	readonly #artifacts: Map<string, HostArtifact>;
	readonly #sessions = new Map<string, Session>();
	readonly #authorize: (request: Request) => boolean | Promise<boolean>;
	readonly #limits: HostLimits;
	readonly #path: string;
	readonly #timer: ReturnType<typeof setInterval>;
	#opening = 0;
	#closed = false;
	#closing?: Promise<void>;
	readonly #opens = new Set<Promise<Response>>();
	constructor(options: {
		artifacts: Readonly<Record<string, HostArtifact>>;
		authorize: (request: Request) => boolean | Promise<boolean>;
		limits?: Partial<HostLimits>;
		path?: string;
	}) {
		this.#artifacts = new Map(Object.entries(options.artifacts));
		this.#authorize = options.authorize;
		this.#limits = { ...defaults, ...options.limits };
		for (const value of Object.values(this.#limits))
			if (!Number.isSafeInteger(value) || value < 1)
				throw new RangeError('invalid host limit');
		if (this.#limits.responseBytes < 512)
			throw new RangeError('response limit must reserve at least 512 bytes for errors');
		this.#path = options.path ?? '/folio';
		if (!/^\/[a-zA-Z0-9/_-]*[a-zA-Z0-9_-]$/.test(this.#path))
			throw new TypeError('invalid host path');
		this.#timer = setInterval(
			() => {
				const now = Date.now();
				for (const [key, session] of this.#sessions) {
					if (session.operations) continue;
					if (now - session.touched < this.#limits.idleMilliseconds) continue;
					if (session.released) this.#sessions.delete(key);
					else if (!session.closed)
						void this.#enqueue(session, () => this.#closeSession(session)).catch(
							() => {}
						);
				}
			},
			Math.min(this.#limits.idleMilliseconds, 60_000)
		);
		this.#timer.unref();
	}
	/** Groups open or opening, counting those still joining their workers. */
	get activeGroups(): number {
		return (
			this.#opening +
			[...this.#sessions.values()].filter((session) => !session.released).length
		);
	}
	#response(value: unknown, status = 200): Response {
		return new Response(this.#serialize(value), {
			status,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		});
	}
	#serialize(value: unknown): string {
		const body = JSON.stringify(encodeValue(value));
		if (new TextEncoder().encode(body).length > this.#limits.responseBytes)
			throw new ProtocolError('response exceeds transport byte limit', 413);
		return body;
	}
	#error(error: unknown): { body: { kind: string; message: string }; status: number } {
		return {
			body: {
				kind: (error instanceof Error ? error.name : 'Error').slice(0, 32),
				message: (error instanceof Error
					? error.message
					: 'execution threw a non-error value'
				).slice(0, Math.min(1024, Math.floor(this.#limits.responseBytes / 32)))
			},
			status: error instanceof ProtocolError ? error.status : 422
		};
	}
	async #body(request: Request): Promise<string> {
		const maximum = this.#limits.requestBytes;
		const reader = request.body?.getReader();
		if (!reader) throw new ProtocolError('request body is required');
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > maximum)
					throw new ProtocolError('request exceeds transport byte limit', 413);
				chunks.push(value);
			}
		} catch (error) {
			await reader.cancel().catch(() => {});
			throw error;
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	}
	#enqueue<T>(session: Session, operation: () => Promise<T>): Promise<T> {
		session.operations++;
		const result = session.tail.then(operation).finally(() => {
			session.operations--;
			session.touched = Date.now();
		});
		session.tail = result.catch(() => {});
		return result;
	}
	#closeSession(session: Session): Promise<void> {
		if (session.closing) return session.closing;
		session.closed = true;
		session.closing = (async () => {
			try {
				await session.pool.close();
			} finally {
				try {
					await session.dispose?.();
				} finally {
					session.released = true;
				}
			}
		})();
		return session.closing;
	}
	async #open(value: any): Promise<Response> {
		if (this.#closed) throw new ProtocolError('execution host is closed', 503);
		if (typeof value.artifact !== 'string' || !this.#artifacts.has(value.artifact))
			throw new ProtocolError('unknown registered artifact', 404);
		if (this.activeGroups >= this.#limits.liveGroups)
			throw new ProtocolError('live group admission limit reached', 429);
		while (this.#sessions.size + this.#opening >= this.#limits.retainedSessions) {
			const oldest = [...this.#sessions].find(([, session]) => session.released);
			if (!oldest) throw new ProtocolError('retained session admission limit reached', 429);
			this.#sessions.delete(oldest[0]);
		}
		const workers =
			value.workers === undefined
				? Math.min(4, this.#limits.workersPerGroup)
				: integer(value.workers, this.#limits.workersPerGroup);
		if (!workers) throw new ProtocolError('at least one worker is required');
		this.#opening++;
		let binding: Awaited<ReturnType<NonNullable<HostArtifact['create']>>> | undefined;
		let pool: Folio | undefined;
		try {
			const artifact = this.#artifacts.get(value.artifact)!;
			binding = await artifact.create?.();
			pool = await Folio.open(artifact.program, { ...binding?.options, workers });
			const memories = new Set(Object.values(pool.memories));
			try {
				memories.add(pool.memory);
			} catch {}
			const totalBytes = [...memories].reduce(
				(sum, memory) => sum + memory.buffer.byteLength,
				0
			);
			if (totalBytes > this.#limits.memoryBytesPerGroup)
				throw new ProtocolError('artifact exceeds memory admission limit', 413);
			if (this.#closed) throw new ProtocolError('execution host is closed', 503);
			const capability = crypto.randomUUID() + crypto.randomUUID();
			const session: Session = {
				pool,
				artifact,
				dispose: binding?.dispose,
				sequence: 0,
				tail: Promise.resolve(),
				operations: 0,
				touched: Date.now(),
				closed: false,
				released: false
			};
			const response = this.#response({
				capability,
				threadIds: [...pool.threadIds],
				capabilities: pool.capabilities
			});
			this.#sessions.set(capability, session);
			return response;
		} catch (error) {
			try {
				await pool?.close();
			} finally {
				await binding?.dispose?.();
			}
			throw error;
		} finally {
			this.#opening--;
		}
	}
	#memory(session: Session, key: unknown): WebAssembly.Memory {
		if (key === undefined) return session.pool.memory;
		if (typeof key !== 'string' || !Object.hasOwn(session.pool.memories, key))
			throw new ProtocolError('unknown memory');
		return session.pool.memories[key]!;
	}
	async #operation(session: Session, value: any): Promise<unknown> {
		if (value.operation === 'close') {
			await this.#closeSession(session);
			return undefined;
		}
		if (value.operation === 'read' || value.operation === 'write') {
			const memory = this.#memory(session, value.memory);
			const offset = integer(value.offset);
			let bytes: Uint8Array | undefined;
			if (value.operation === 'write') {
				if (
					typeof value.bytes !== 'string' ||
					value.bytes.length > this.#limits.writeBytes * 2
				)
					throw new ProtocolError('write exceeds transport byte limit', 413);
				bytes = decodeBytes(value.bytes);
			}
			const length = bytes?.length ?? integer(value.length, this.#limits.readBytes);
			if (offset > memory.buffer.byteLength || length > memory.buffer.byteLength - offset)
				throw new ProtocolError('memory range is out of bounds');
			if (bytes) {
				new Uint8Array(memory.buffer, offset, length).set(bytes);
				return undefined;
			}
			return encodeBytes(new Uint8Array(memory.buffer, offset, length));
		}
		if (value.operation === 'run') {
			if (typeof value.entry !== 'string' || !session.artifact.exports.includes(value.entry))
				throw new ProtocolError('export is not authorized', 403);
			if (
				!Array.isArray(value.args) ||
				value.args.length > this.#limits.argumentsPerCall ||
				value.args.some((arg: unknown) => !['number', 'bigint'].includes(typeof arg))
			)
				throw new ProtocolError('arguments must be bounded numeric Wasm values');
			const options = value.options ?? {};
			if (
				options.parallel !== undefined &&
				!['auto', 'off', 'speculate'].includes(options.parallel)
			)
				throw new ProtocolError('invalid parallel option');
			const maximumWorkers =
				options.maximumWorkers === undefined
					? undefined
					: integer(options.maximumWorkers, this.#limits.workersPerGroup);
			if (maximumWorkers === 0) throw new ProtocolError('at least one worker is required');
			return session.pool.run(value.entry, value.args, {
				parallel: options.parallel,
				maximumWorkers
			} as RunOptions);
		}
		throw new ProtocolError('unknown operation');
	}
	async #session(session: Session, text: string, value: any): Promise<Response> {
		return this.#enqueue(session, async () => {
			session.touched = Date.now();
			const sequence = integer(value.sequence);
			if (sequence === session.sequence - 1 && session.last) {
				if (text !== session.last.body)
					throw new ProtocolError('sequence was reused with different input', 409);
				return new Response(session.last.response, {
					status: session.last.status,
					headers: {
						'content-type': 'application/json',
						'cache-control': 'no-store',
						'x-folio-sequence': String(sequence)
					}
				});
			}
			if (sequence !== session.sequence)
				throw new ProtocolError('out of order session request', 409);
			if (session.closed) throw new ProtocolError('session is closed', 410);
			let response: string,
				status = 200;
			try {
				response = this.#serialize(await this.#operation(session, value));
			} catch (error) {
				const failure = this.#error(error);
				status = failure.status;
				response = this.#serialize(failure.body);
			}
			session.last = { body: text, response, status };
			session.sequence++;
			return new Response(response, {
				status,
				headers: {
					'content-type': 'application/json',
					'cache-control': 'no-store',
					'x-folio-sequence': String(sequence)
				}
			});
		});
	}
	/** The authenticated handler to mount behind a service binding or an HTTP server. */
	readonly fetch = async (request: Request): Promise<Response> => {
		try {
			if (!(await this.#authorize(request)))
				throw new ProtocolError('authorization required', 401);
			if (request.method !== 'POST') throw new ProtocolError('POST is required', 405);
			if (this.#closed) throw new ProtocolError('execution host is closed', 503);
			const path = new URL(request.url).pathname;
			if (path !== this.#path && !path.startsWith(`${this.#path}/`))
				throw new ProtocolError('unknown host route', 404);
			const text = await this.#body(request);
			const value = decodeValue(JSON.parse(text));
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new ProtocolError('request must be a record');
			if (path === this.#path) {
				const pending = this.#open(value);
				this.#opens.add(pending);
				try {
					return await pending;
				} finally {
					this.#opens.delete(pending);
				}
			}
			const session = this.#sessions.get(path.slice(this.#path.length + 1));
			if (!session) throw new ProtocolError('unknown session', 404);
			return await this.#session(session, text, value);
		} catch (error) {
			const failure = this.#error(error);
			return this.#response(failure.body, failure.status);
		}
	};
	/** Refuses new sessions, then joins every group's workers and pending effects. */
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		clearInterval(this.#timer);
		this.#closing = (async () => {
			await Promise.allSettled([...this.#opens]);
			const closed = await Promise.allSettled(
				[...this.#sessions.values()].map((session) =>
					this.#enqueue(session, () => this.#closeSession(session))
				)
			);
			this.#sessions.clear();
			const failure = closed.find((result) => result.status === 'rejected');
			if (failure?.status === 'rejected') throw failure.reason;
		})();
		return this.#closing;
	}
	/** `await using` support; equivalent to `close()`. */
	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}
