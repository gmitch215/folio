/** Portable transport values. References and executable objects do not cross this boundary. */
export function encodeValue(value: unknown, depth = 0): unknown {
	if (depth > 64) throw new RangeError('transport value is too deeply nested');
	if (value === undefined) return ['u'];
	if (typeof value === 'number') {
		const view = new DataView(new ArrayBuffer(8));
		view.setFloat64(0, value);
		return ['n', view.getBigUint64(0).toString(16).padStart(16, '0')];
	}
	if (typeof value === 'bigint') return ['i', value.toString()];
	if (value === null || typeof value === 'boolean' || typeof value === 'string')
		return ['v', value];
	if (Array.isArray(value)) return ['a', value.map((item) => encodeValue(item, depth + 1))];
	if (
		value &&
		typeof value === 'object' &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	)
		return [
			'o',
			Object.entries(value).map(([key, item]) => [key, encodeValue(item, depth + 1)])
		];
	throw new TypeError('transport accepts values, not object identities or executable objects');
}

/** Inverse of `encodeValue`; rejects anything that is not a transport value. */
export function decodeValue(value: unknown, depth = 0): any {
	if (depth > 64 || !Array.isArray(value)) throw new TypeError('invalid transport value');
	const [kind, payload] = value;
	if (kind === 'u' && value.length === 1) return undefined;
	if (
		kind === 'v' &&
		value.length === 2 &&
		(payload === null || ['boolean', 'string'].includes(typeof payload))
	)
		return payload;
	if (
		kind === 'n' &&
		value.length === 2 &&
		typeof payload === 'string' &&
		/^[0-9a-f]{16}$/.test(payload)
	) {
		const view = new DataView(new ArrayBuffer(8));
		view.setBigUint64(0, BigInt(`0x${payload}`));
		return view.getFloat64(0);
	}
	if (
		kind === 'i' &&
		value.length === 2 &&
		typeof payload === 'string' &&
		/^(0|-?[1-9][0-9]*)$/.test(payload) &&
		payload.length <= 4096
	)
		return BigInt(payload);
	if (kind === 'a' && value.length === 2 && Array.isArray(payload))
		return payload.map((item) => decodeValue(item, depth + 1));
	if (kind === 'o' && value.length === 2 && Array.isArray(payload)) {
		const result: Record<string, unknown> = {};
		for (const pair of payload) {
			if (
				!Array.isArray(pair) ||
				pair.length !== 2 ||
				typeof pair[0] !== 'string' ||
				Object.hasOwn(result, pair[0])
			)
				throw new TypeError('invalid transport record');
			Object.defineProperty(result, pair[0], {
				value: decodeValue(pair[1], depth + 1),
				enumerable: true,
				writable: true,
				configurable: true
			});
		}
		return result;
	}
	throw new TypeError('invalid transport value');
}

/** Lowercase hex text for a byte payload. */
export function encodeBytes(bytes: Uint8Array): string {
	let result = '';
	for (const value of bytes) result += value.toString(16).padStart(2, '0');
	return result;
}

/** Inverse of `encodeBytes`; rejects odd lengths and non-hex text. */
export function decodeBytes(value: unknown): Uint8Array {
	if (typeof value !== 'string' || value.length % 2 || !/^[0-9a-f]*$/.test(value))
		throw new TypeError('invalid byte payload');
	return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
		parseInt(value.slice(index * 2, index * 2 + 2), 16)
	);
}

/** The host's execution report, decoded. Fields match `ExecutionReport`. */
export interface RemoteReport {
	/** Return values; i64 results arrive as bigint and void as undefined. */
	values: unknown[];
	/** Workers that executed regions. */
	workers: number;
	/** Regions dispatched. */
	regions: number;
	/** Regions replayed after a conflict. */
	replayed: number;
	/** Regions that fell back to native execution at the host. */
	fallbacks: number;
	/** How the host ran the call. */
	mode: 'serial' | 'speculative' | 'native-shared';
	/** Set when control-flow extraction produced the regions. */
	extraction?: 'control-flow';
	/** Whether regions read the shared allocation or a copied snapshot. */
	memoryMode?: 'shared' | 'snapshot';
	/** Bytes copied for snapshot execution. */
	snapshotBytes?: number;
	/** Why the run stayed serial or left the fast path. */
	reason?: string;
	/** Present when the host profiles runs. */
	profile?: unknown;
}

/** Connection options for `RemoteFolio.open`. */
export interface RemoteOptions {
	/** A service binding's fetch, or an ordinary fetch implementation. */
	fetch?: (input: Request) => Promise<Response>;
	/** Sent with every request, usually `authorization`. */
	headers?: HeadersInit;
	/** Largest response body the client reads; defaults to 2 MiB. */
	maximumResponseBytes?: number;
}

/** An error response from the host. */
export class RemoteError extends Error {
	/** HTTP status of the response. */
	readonly status: number;
	/** The host's error category. */
	readonly kind: string;
	constructor(message: string, status: number, kind: string) {
		super(message);
		this.status = status;
		this.kind = kind;
		this.name = 'RemoteError';
	}
}

/** A failed response can be retried explicitly with the exact original request. */
export class UncertainDelivery extends Error {
	/** Sequence number of the request whose response was lost. */
	readonly sequence: number;
	constructor(sequence: number, options?: ErrorOptions) {
		super(
			'delivery is uncertain; retryPending() retrieves the result without replaying effects',
			options
		);
		this.sequence = sequence;
		this.name = 'UncertainDelivery';
	}
}

async function readBounded(response: Response, maximum: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maximum) throw new RangeError('response exceeds transport byte limit');
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

/** Connects to a registered artifact. Compilation and shared memory stay at the host. */
export class RemoteFolio {
	/** Session details from the host: its capability, worker thread ids and sharing capabilities. */
	readonly info: { capability: string; threadIds: number[]; capabilities: unknown };
	readonly #url: URL;
	readonly #request: (input: Request) => Promise<Response>;
	readonly #headers: Headers;
	readonly #maximum: number;
	#sequence = 0;
	#pending?: { body: string; close: boolean };
	#busy = false;
	#closed = false;
	private constructor(
		url: URL,
		info: {
			capability: string;
			threadIds: number[];
			capabilities: unknown;
		},
		options: RemoteOptions
	) {
		this.info = info;
		this.#url = new URL(encodeURIComponent(info.capability), `${url.href.replace(/\/$/, '')}/`);
		this.#request = options.fetch ?? fetch;
		this.#headers = new Headers(options.headers);
		this.#headers.set('content-type', 'application/json');
		this.#maximum = options.maximumResponseBytes ?? 2 * 1024 * 1024;
	}
	/** Opens a session on a registered artifact; `workers` asks for a group width within host limits. */
	static async open(
		url: string | URL,
		artifact: string,
		options: RemoteOptions & {
			workers?: number;
		} = {}
	): Promise<RemoteFolio> {
		const headers = new Headers(options.headers);
		headers.set('content-type', 'application/json');
		const response = await (options.fetch ?? fetch)(
			new Request(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(encodeValue({ artifact, workers: options.workers }))
			})
		);
		const value = decodeValue(
			JSON.parse(await readBounded(response, options.maximumResponseBytes ?? 2 * 1024 * 1024))
		);
		if (!response.ok) throw new RemoteError(value.message, response.status, value.kind);
		return new RemoteFolio(new URL(url), value, options);
	}
	async #send(): Promise<any> {
		const pending = this.#pending!;
		try {
			const response = await this.#request(
				new Request(this.#url, {
					method: 'POST',
					headers: this.#headers,
					body: pending.body
				})
			);
			const value = decodeValue(JSON.parse(await readBounded(response, this.#maximum)));
			const accepted = response.headers.get('x-folio-sequence') === String(this.#sequence);
			if (response.ok && !accepted) throw new Error('host omitted the accepted sequence');
			this.#pending = undefined;
			if (accepted) this.#sequence++;
			if (pending.close && accepted) this.#closed = true;
			if (!response.ok) throw new RemoteError(value.message, response.status, value.kind);
			return value;
		} catch (error) {
			if (!this.#pending) throw error;
			throw new UncertainDelivery(this.#sequence, { cause: error });
		}
	}
	async #command(command: Record<string, unknown>): Promise<any> {
		if (this.#closed) throw new Error('remote folio is closed');
		if (this.#busy) throw new Error('remote session already has an active request');
		if (this.#pending) throw new Error('retry the uncertain request before another operation');
		this.#busy = true;
		try {
			this.#pending = {
				body: JSON.stringify(encodeValue({ sequence: this.#sequence, ...command })),
				close: command.operation === 'close'
			};
			return await this.#send();
		} finally {
			this.#busy = false;
		}
	}
	/** Resends the exact uncertain request; the host returns its cached result without repeating effects. */
	async retryPending(): Promise<any> {
		if (this.#busy || !this.#pending) throw new Error('no uncertain request is available');
		this.#busy = true;
		try {
			return await this.#send();
		} finally {
			this.#busy = false;
		}
	}
	/** Runs one allowlisted export in order on the host. */
	async run(
		entry: string,
		args: readonly unknown[] = [],
		options: {
			parallel?: 'auto' | 'off' | 'speculate';
			maximumWorkers?: number;
		} = {}
	): Promise<RemoteReport> {
		return this.#command({ operation: 'run', entry, args, options });
	}
	/** Reads bytes from the host's memory, bounded by the host's read limit. */
	async read(offset: number, length: number, memory?: string): Promise<Uint8Array> {
		return decodeBytes(await this.#command({ operation: 'read', offset, length, memory }));
	}
	/** Writes bytes into the host's memory, bounded by the host's write limit. */
	async write(offset: number, bytes: Uint8Array, memory?: string): Promise<void> {
		await this.#command({ operation: 'write', offset, bytes: encodeBytes(bytes), memory });
	}
	/** Ends the session; the host joins its workers before releasing the slot. */
	async close(): Promise<void> {
		if (this.#closed) return;
		await this.#command({ operation: 'close' });
	}
	/** `await using` support; equivalent to `close()`. */
	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}
