import { bytesEqual, ContextKernel, pick, toHex, type ContextSubject } from './affine-state.ts';
import type { TaskPool } from './tasks.ts';

/**
 * The state of a serial chain at every `step` bytes: `starts[k]` is the state before byte
 * `k * step`. The caller keeps it and passes it back; nothing is cached globally.
 */
export interface BoundaryLog {
	step: number;
	starts: Uint8Array[];
}

export interface RecordOptions {
	/** Bytes between recorded states. */
	step: number;
	/** State before the first byte. The default is the state bytes of `subject.context`. */
	initial?: Uint8Array;
}

export interface VerifyOptions {
	initial?: Uint8Array;
	/** Step of the fresh log when the given log is unusable. The default is two chunks per worker. */
	step?: number;
}

export interface VerifyResult {
	state: Uint8Array;
	/** The log for this input: the verified prefix of the old one, then fresh states. */
	log: BoundaryLog;
	/** Chunks that ran in parallel from a recorded start. */
	chunks: number;
	tasks: number;
	/** Boundaries where a chunk's end state equalled the next recorded start. */
	validated: number;
	/** The first chunk whose end state differed from the next recorded start, or -1. */
	mismatchAt: number;
	/** Bytes that ran serially after the parallel pass. */
	fallbackBytes: number;
	/** The log was unusable or its first start differed from the initial state. */
	stale: boolean;
}

const checkStep = (step: number) => {
	if (!Number.isSafeInteger(step) || step < 1) throw new RangeError('invalid step');
};

/**
 * Runs the chain serially on a private instance in the calling thread and records the state at
 * every `step` bytes. The copy at each boundary costs a few hundred bytes. The state returned is
 * the one a single call over the whole input returns when the kernel composes over a split.
 */
export function recordBoundaries(
	subject: ContextSubject,
	input: Uint8Array,
	options: RecordOptions
): { state: Uint8Array; log: BoundaryLog } {
	checkStep(options.step);
	const kernel = new ContextKernel(subject.module, subject.layout.entry);
	const initial = options.initial ?? pick(subject.context, subject.state);
	if (initial.length !== subject.state.length)
		throw new RangeError('invalid initial state length');
	const starts: Uint8Array[] = [];
	let state = initial;
	for (let at = 0; at < input.length; at += options.step) {
		starts.push(state);
		const image = Uint8Array.from(subject.context);
		subject.state.forEach((o, k) => (image[o] = state[k]!));
		const out = kernel.run(subject.layout, image, input.subarray(at, at + options.step));
		if (!out) throw new Error('the kernel trapped');
		state = pick(out, subject.state);
	}
	return { state, log: { step: options.step, starts } };
}

/**
 * Runs every chunk of `input` in parallel from the start state the log recorded for it, on workers
 * started with `serveContext`, and compares each end state with the next recorded start. If all
 * agree, the last end state is the serial result, by induction: each chunk ran from a state that
 * the chunk before it ended in. Nothing about the bytes is trusted or hashed, so a log recorded for
 * other bytes, other lengths or another chain shows up as a difference and never changes the result.
 *
 * At the first difference the real end state of that chunk is a real state, and the rest of the
 * input runs serially from it in one task that records fresh boundaries; the recorded starts after
 * that point are dropped. An edit that changes a chunk's bytes but not its end state (a chain that
 * forgets) is not a difference, so the chunks after it stay valid.
 */
export function verifyBoundaries(
	pool: TaskPool,
	subject: ContextSubject,
	input: Uint8Array,
	log: BoundaryLog,
	options: VerifyOptions = {}
): VerifyResult {
	const width = subject.state.length;
	const initial = options.initial ?? pick(subject.context, subject.state);
	if (initial.length !== width) throw new RangeError('invalid initial state length');
	const length = input.length;
	const fresh: BoundaryLog = {
		step: options.step ?? Math.max(1, Math.ceil(length / (2 * pool.width))),
		starts: []
	};
	if (!length)
		return {
			state: initial,
			log: fresh,
			chunks: 0,
			tasks: 0,
			validated: 0,
			mismatchAt: -1,
			fallbackBytes: 0,
			stale: false
		};

	const usable =
		Number.isSafeInteger(log?.step) &&
		log.step > 0 &&
		Array.isArray(log.starts) &&
		log.starts.length > 0 &&
		log.starts.every((s) => s instanceof Uint8Array && s.length === width) &&
		bytesEqual(log.starts[0]!, initial);
	const step = usable ? log.step : fresh.step;
	const chunks = usable ? Math.min(log.starts.length, Math.ceil(length / step)) : 0;
	let tasks = 0;
	const submit = (name: string, from: number, to: number) => {
		tasks++;
		return pool.submit(name, input.slice(from, to));
	};

	const handles = Array.from({ length: chunks }, (_, k) =>
		submit(`ctx:${toHex(log.starts[k]!)}`, k * step, Math.min((k + 1) * step, length))
	);
	// every chunk up to `done` ran from a state that is the real state at its start
	let done = -1;
	let real = initial;
	let mismatchAt = -1;
	let validated = 0;
	for (let k = 0; k < chunks; k++) {
		const end = pool.join(handles[k]!).bytes;
		real = end;
		done = k;
		if (k === chunks - 1) break;
		if (!bytesEqual(end, log.starts[k + 1]!)) {
			mismatchAt = k;
			break;
		}
		validated++;
	}
	const covered = Math.min((done + 1) * step, length);
	const starts = usable ? log.starts.slice(0, done + 1) : [];
	let state = real;
	let fallbackBytes = 0;
	if (covered < length) {
		fallbackBytes = length - covered;
		const task = submit(`ctxrec:${toHex(real)}:${step}`, covered, length);
		// the speculative chunks after a mismatch are joined last so they do not delay the tail
		const rest = pool.join(task).bytes;
		const pieces = rest.length / width;
		starts.push(real);
		for (let p = 0; p < pieces - 1; p++) starts.push(rest.slice(p * width, (p + 1) * width));
		state = rest.slice((pieces - 1) * width);
	}
	for (let k = done + 1; k < chunks; k++) {
		try {
			pool.join(handles[k]!);
		} catch {
			// a speculative chunk that started from a forged state may trap; it is not part of the result
		}
	}
	return {
		state,
		log: { step, starts },
		chunks,
		tasks,
		validated,
		mismatchAt,
		fallbackBytes,
		stale: !usable
	};
}
