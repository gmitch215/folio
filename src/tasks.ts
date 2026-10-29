import { MessageChannel, type MessagePort, receiveMessageOnPort } from 'node:worker_threads';

/** Task input and output are copied between threads. Strings and bytes are both accepted. */
export type TaskInput = string | Uint8Array;

/** The end of a pool link that a worker passes to `serveTasks`. */
export interface TaskLink {
	port: MessagePort;
	signal: SharedArrayBuffer;
}

/** Timing and size evidence for one joined task. Timestamps are epoch milliseconds. */
export interface TaskRecord {
	id: string;
	worker: number;
	name: string;
	submitMs: number;
	startMs: number;
	endMs: number;
	waitMs: number;
	cpuMs?: number;
	inputBytes: number;
	outputBytes: number;
}

/** Options for `TaskPool`. */
export interface TaskPoolOptions {
	/**
	 * Differential check. Every `every`th task runs again with `run` in the joining thread and the
	 * two outputs are compared byte for byte. A difference means the task depended on state the
	 * serial program would have shared, and `join` throws `TaskConflictError`.
	 */
	audit?: {
		run(name: string, input: TaskInput): TaskInput;
		every?: number;
	};
}

/** A task function threw in its worker. */
export class TaskError extends Error {
	readonly task: string;
	readonly worker: number;

	constructor(task: string, worker: number, detail: string) {
		super(`task ${task} failed on worker ${worker}: ${detail}`);
		this.name = 'TaskError';
		this.task = task;
		this.worker = worker;
	}
}

/** An audited task returned different bytes in its worker than in the joining thread. */
export class TaskConflictError extends Error {
	readonly task: string;
	readonly worker: number;
	readonly offset: number;

	constructor(task: string, worker: number, offset: number) {
		super(`task ${task} on worker ${worker} differs from the serial result at byte ${offset}`);
		this.name = 'TaskConflictError';
		this.task = task;
		this.worker = worker;
		this.offset = offset;
	}
}

/** The joined output of a task, with decoded accessors. */
export class TaskResult {
	readonly bytes: Uint8Array;
	readonly record: TaskRecord;

	constructor(bytes: Uint8Array, record: TaskRecord) {
		this.bytes = bytes;
		this.record = record;
	}

	text(): string {
		return decoder.decode(this.bytes);
	}

	json<T = unknown>(): T {
		return JSON.parse(this.text()) as T;
	}
}

interface Request {
	id: string;
	name: string;
	input: TaskInput;
	submitMs: number;
}

interface Reply {
	id: string;
	ok: boolean;
	output: Uint8Array;
	startMs: number;
	endMs: number;
	cpuMs?: number;
}

interface Pending {
	id: string;
	worker: number;
	name: string;
	submitMs: number;
	inputBytes: number;
	audited?: TaskInput;
}

interface AsyncWait {
	waitAsync(
		view: Int32Array,
		index: number,
		value: number
	): { async: false } | { async: true; value: Promise<unknown> };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const now = () => performance.timeOrigin + performance.now();

function toBytes(value: TaskInput): Uint8Array {
	return typeof value === 'string' ? encoder.encode(value) : value;
}

function threadCpuMs(): number | undefined {
	const usage = process.threadCpuUsage?.();
	return usage ? (usage.user + usage.system) / 1000 : undefined;
}

/**
 * Creates `count` linked channel pairs. Pass the `owner` ends to `new TaskPool` in the thread that
 * submits tasks, which may be a worker, and the `server` ends to `serveTasks` in the workers.
 * Each port must be listed in the `transferList` of the thread it travels to.
 */
export function createTaskLinks(count: number): { owner: TaskLink[]; server: TaskLink[] } {
	if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('invalid worker count');
	const owner: TaskLink[] = [];
	const server: TaskLink[] = [];
	for (let index = 0; index < count; index++) {
		const channel = new MessageChannel();
		const signal = new SharedArrayBuffer(4);
		owner.push({ port: channel.port1, signal });
		server.push({ port: channel.port2, signal });
	}
	return { owner, server };
}

/**
 * Runs named functions in private contexts on other threads. The owner submits a task with a name
 * and a copied input, keeps working, and joins the copied output. Nothing is shared between the
 * owner and a worker, so tasks must not depend on each other's state; `audit` checks that.
 * `new TaskPool(count)` creates the channels. The caller starts each worker, hands it
 * `link(index)` and calls `serveTasks` there. `new TaskPool(links)` attaches to owner ends made
 * by `createTaskLinks`, for an owner that runs in a worker.
 */
export class TaskPool {
	readonly #owner: TaskLink[];
	readonly #server?: TaskLink[];
	readonly #counters: Int32Array[];
	readonly #replies = new Map<string, Reply>();
	readonly #pending = new Map<string, Pending>();
	readonly #audit?: TaskPoolOptions['audit'];
	#log: TaskRecord[] = [];
	#width: number;
	#next = 0;
	#seq = 0;
	#closed = false;

	constructor(source: number | TaskLink[], options: TaskPoolOptions = {}) {
		const every = options.audit?.every ?? 1;
		if (!Number.isSafeInteger(every) || every < 1)
			throw new RangeError('invalid audit interval');
		this.#audit = options.audit && { run: options.audit.run, every };
		if (typeof source === 'number') {
			const links = createTaskLinks(source);
			this.#owner = links.owner;
			this.#server = links.server;
		} else {
			if (!source.length) throw new RangeError('invalid worker count');
			this.#owner = source;
		}
		this.#counters = this.#owner.map((link) => new Int32Array(link.signal));
		this.#width = this.#owner.length;
	}

	/** Number of worker links. */
	get size(): number {
		return this.#owner.length;
	}

	/** Tasks are spread round robin over the first `width` workers. */
	get width(): number {
		return this.#width;
	}

	set width(value: number) {
		if (!Number.isSafeInteger(value) || value < 1 || value > this.size)
			throw new RangeError('invalid width');
		this.#width = value;
		this.#next = 0;
	}

	/** The worker end of link `index`. List its port in the worker's `transferList`. */
	link(index: number): TaskLink {
		if (!this.#server) throw new Error('this pool was attached to existing links');
		const link = this.#server[index];
		if (!link) throw new RangeError('invalid worker index');
		return link;
	}

	/** Starts a task and returns a handle for `join`. */
	submit(name: string, input: TaskInput = ''): string {
		if (this.#closed) throw new Error('task pool is closed');
		const worker = this.#next++ % this.#width;
		const seq = this.#seq++;
		const id = `${worker}:${seq}`;
		const submitMs = now();
		// postMessage shares a SharedArrayBuffer instead of copying it
		const posted =
			typeof input !== 'string' && input.buffer instanceof SharedArrayBuffer
				? Uint8Array.from(input)
				: input;
		this.#owner[worker]!.port.postMessage({
			id,
			name,
			input: posted,
			submitMs
		} satisfies Request);
		const sampled = this.#audit && seq % this.#audit.every! === 0;
		const audited = sampled
			? typeof input === 'string' || posted !== input
				? posted
				: Uint8Array.from(input)
			: undefined;
		this.#pending.set(id, {
			id,
			worker,
			name,
			submitMs,
			inputBytes: toBytes(input).length,
			audited
		});
		return id;
	}

	/** Starts a task whose input is a JSON value. */
	submitJson(name: string, value: unknown): string {
		return this.submit(name, JSON.stringify(value));
	}

	/** Blocks the calling thread until the task finishes. Use it where the caller cannot yield. */
	join(handle: string): TaskResult {
		const pending = this.#claim(handle);
		const counter = this.#counters[pending.worker]!;
		let waitMs = 0;
		let reply = this.#reply(pending);
		while (!reply) {
			const seen = Atomics.load(counter, 0);
			reply = this.#reply(pending);
			if (reply) break;
			const start = now();
			Atomics.wait(counter, 0, seen);
			waitMs += now() - start;
		}
		return this.#finish(pending, reply, waitMs);
	}

	/** Waits for the task without blocking the event loop. */
	async joinAsync(handle: string): Promise<TaskResult> {
		const pending = this.#claim(handle);
		const counter = this.#counters[pending.worker]!;
		const atomics = Atomics as unknown as AsyncWait;
		let waitMs = 0;
		let reply = this.#reply(pending);
		while (!reply) {
			const seen = Atomics.load(counter, 0);
			reply = this.#reply(pending);
			if (reply) break;
			const start = now();
			const wait = atomics.waitAsync(counter, 0, seen);
			if (wait.async) await wait.value;
			waitMs += now() - start;
		}
		return this.#finish(pending, reply, waitMs);
	}

	/** Submits every job, then joins them in submission order. */
	async run(jobs: [name: string, input?: TaskInput][]): Promise<TaskResult[]> {
		const handles = jobs.map(([name, input]) => this.submit(name, input));
		const results: TaskResult[] = [];
		for (const handle of handles) results.push(await this.joinAsync(handle));
		return results;
	}

	/** Blocking form of `run`. */
	runSync(jobs: [name: string, input?: TaskInput][]): TaskResult[] {
		const handles = jobs.map(([name, input]) => this.submit(name, input));
		return handles.map((handle) => this.join(handle));
	}

	/** Returns the records of tasks joined since the last call and clears them. */
	drain(): TaskRecord[] {
		const out = this.#log;
		this.#log = [];
		return out;
	}

	/** Closes the channels. Tasks that were not joined are dropped. */
	close(): void {
		this.#closed = true;
		this.#replies.clear();
		this.#pending.clear();
		for (const link of this.#owner) link.port.close();
	}

	#claim(handle: string): Pending {
		const pending = this.#pending.get(handle);
		if (!pending) throw new Error(`unknown or already joined task ${handle}`);
		this.#pending.delete(handle);
		return pending;
	}

	#reply(pending: Pending): Reply | undefined {
		const port = this.#owner[pending.worker]!.port;
		let message;
		while ((message = receiveMessageOnPort(port))) {
			const reply = message.message as Reply;
			this.#replies.set(reply.id, reply);
		}
		const reply = this.#replies.get(pending.id);
		if (reply) this.#replies.delete(pending.id);
		return reply;
	}

	#finish(pending: Pending, reply: Reply, waitMs: number): TaskResult {
		if (!reply.ok)
			throw new TaskError(pending.name, pending.worker, decoder.decode(reply.output));
		if (pending.audited !== undefined && this.#audit) {
			const local = toBytes(this.#audit.run(pending.name, pending.audited));
			const offset = firstDifference(local, reply.output);
			if (offset >= 0) throw new TaskConflictError(pending.name, pending.worker, offset);
		}
		const record: TaskRecord = {
			id: pending.id,
			worker: pending.worker,
			name: pending.name,
			submitMs: pending.submitMs,
			startMs: reply.startMs,
			endMs: reply.endMs,
			waitMs,
			cpuMs: reply.cpuMs,
			inputBytes: pending.inputBytes,
			outputBytes: reply.output.length
		};
		this.#log.push(record);
		return new TaskResult(reply.output, record);
	}
}

function firstDifference(a: Uint8Array, b: Uint8Array): number {
	const shared = Math.min(a.length, b.length);
	for (let index = 0; index < shared; index++) if (a[index] !== b[index]) return index;
	return a.length === b.length ? -1 : shared;
}

/** Options for `serveTasks`. */
export interface ServeOptions {
	/** Reads this thread's CPU time in milliseconds. Defaults to `process.threadCpuUsage`. */
	cpu?: () => number | undefined;
}

/** Runs on the worker side. Tasks on one link run one at a time, in arrival order. */
export function serveTasks(
	link: TaskLink,
	run: (name: string, input: TaskInput) => TaskInput | Promise<TaskInput>,
	options: ServeOptions = {}
): void {
	const counter = new Int32Array(link.signal);
	const cpu = options.cpu ?? threadCpuMs;
	let chain: Promise<void> = Promise.resolve();
	link.port.on('message', (request: Request) => {
		chain = chain.then(() => execute(request));
	});

	async function execute(request: Request): Promise<void> {
		const cpuStart = cpu();
		const startMs = now();
		let ok = true;
		let output: Uint8Array;
		try {
			output = toBytes(await run(request.name, request.input));
		} catch (error) {
			ok = false;
			output = encoder.encode(String((error as Error)?.stack ?? error));
		}
		const cpuEnd = cpu();
		const reply: Reply = {
			id: request.id,
			ok,
			output,
			startMs,
			endMs: now(),
			cpuMs: cpuStart === undefined || cpuEnd === undefined ? undefined : cpuEnd - cpuStart
		};
		link.port.postMessage(reply);
		Atomics.add(counter, 0, 1);
		Atomics.notify(counter, 0);
	}
}

/** The largest number of tasks whose intervals overlap at one instant. */
export function peakConcurrency(records: Pick<TaskRecord, 'startMs' | 'endMs'>[]): number {
	const edges: [number, number][] = [];
	for (const record of records) edges.push([record.startMs, 1], [record.endMs, -1]);
	edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let open = 0;
	let peak = 0;
	for (const [, delta] of edges) {
		open += delta;
		peak = Math.max(peak, open);
	}
	return peak;
}
