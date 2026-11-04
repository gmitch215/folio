import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { predictEnd, type AffineLayout } from './affine.ts';
import { guardInput, type StreamCertificate } from './certify.ts';
import { chunkRanges, type FoldChunk } from './fold.ts';
import { serveTasks, type TaskLink, type TaskPool } from './tasks.ts';

/** The task name `serveCertified` answers: `certified:<start state in hex>`. */
export const CERTIFIED_TASK = 'certified';

const compactImports = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
const PAGE = 65536;

/** A module that imports one shared memory, and the bytes the executor writes into that memory first. */
export interface SharedSubject {
	/** The original module with its memory imported as `env.memory` and its data segments made passive. */
	bytes: Uint8Array<ArrayBuffer>;
	/** Data segments and the bytes the first call would write, in address order. */
	prefill: { address: number; bytes: Uint8Array }[];
	/** The size of the memory the module expects, in pages. */
	pages: number;
	certificate: StreamCertificate;
}

/**
 * Rewrites a certified module to run on a memory the caller owns. Only the memory declaration and
 * the data segments change: the functions stay as they were, so the certificate still describes
 * them. The segments become passive so that no instance overwrites the shared bytes, and `prefill`
 * carries what they held, together with the table a lazily initializing module builds on its
 * first call, so every worker starts from the memory the proof assumed.
 */
export function shareCertified(
	bytes: Uint8Array,
	certificate: StreamCertificate,
	pages: number
): SharedSubject {
	if (createHash('sha256').update(bytes).digest('hex') !== certificate.moduleSha256)
		throw new Error('the certificate describes a different module');
	const module = binaryen.readBinary(bytes);
	try {
		module.setFeatures(binaryen.Features.All & ~compactImports);
		const memory = module.getMemoryInfo();
		if (pages < memory.initial || pages > 65536) throw new RangeError('pages out of range');
		const prefill: { address: number; bytes: Uint8Array }[] = [];
		const count: number = (module as any).getNumDataSegments();
		for (let i = 0; i < count; i++) {
			const seg = (module as any).getDataSegmentInfo(
				(module as any).getDataSegmentByIndex(i)
			);
			prefill.push({ address: seg.offset, bytes: new Uint8Array(seg.data) });
		}
		for (const w of certificate.initialization)
			prefill.push({
				address: w.address,
				bytes: Uint8Array.from(w.hex.match(/../g) ?? [], (h) => parseInt(h, 16))
			});
		let text = module.emitText();
		const declared = /\(memory (\$\S+) (\d+)(?: (\d+))?\)/.exec(text);
		if (!declared) throw new Error('the module has no plain memory declaration');
		text = text.replace(
			declared[0],
			`(import "env" "memory" (memory ${declared[1]} ${declared[2]} ${pages} shared))`
		);
		text = text.replace(/\(data (\$\S+) \(i32\.const \d+\) /g, '(data $1 ');
		const shared = binaryen.parseText(text);
		try {
			shared.setFeatures(binaryen.Features.All & ~compactImports);
			if (!shared.validate()) throw new Error('the shared module does not validate');
			return {
				bytes: Uint8Array.from(shared.emitBinary()),
				prefill,
				pages,
				certificate
			};
		} finally {
			shared.dispose();
		}
	} finally {
		module.dispose();
	}
}

/** Writes the subject's prefill into `memory`, which must hold `pages` pages. */
export function installPrefill(subject: SharedSubject, memory: WebAssembly.Memory): void {
	if (memory.buffer.byteLength !== subject.pages * PAGE)
		throw new RangeError('the memory is not the size the module was prepared for');
	for (const part of subject.prefill)
		new Uint8Array(memory.buffer, part.address, part.bytes.length).set(part.bytes);
}

/**
 * Runs on the worker side. Instantiates the shared module on the shared memory and answers
 * `certified:<hex state>` tasks: the input is a view of the shared memory, which is read in place,
 * and the output is the 8-byte little-endian end state.
 */
export function serveCertified(
	link: TaskLink,
	subject: { module: WebAssembly.Module; memory: WebAssembly.Memory; layout: AffineLayout }
): void {
	const instance = new WebAssembly.Instance(subject.module, { env: { memory: subject.memory } });
	const fn = instance.exports[subject.layout.entry] as (
		...args: (number | bigint)[]
	) => number | bigint;
	const { layout } = subject;
	serveTasks(link, (name, input) => {
		const [task, hex] = name.split(':');
		if (task !== CERTIFIED_TASK || !hex || typeof input === 'string')
			throw new Error(`unknown task ${name}`);
		const args: (number | bigint)[] = [0, 0, 0];
		const state = BigInt(`0x${hex}`);
		args[layout.state] =
			layout.bits === 32 ? Number(BigInt.asIntN(32, state)) : BigInt.asIntN(64, state);
		args[layout.ptr] = input.byteOffset;
		args[layout.len] = input.length;
		const end = BigInt.asUintN(layout.bits, BigInt(fn(...args)));
		const out = new Uint8Array(8);
		new DataView(out.buffer).setBigUint64(0, end, true);
		return out;
	});
}

export interface CertifiedFoldOptions {
	/** State before the first byte. The default is 0. */
	initial?: bigint;
	/** Explicit chunk ranges. The default splits the input into `pool.width` chunks. */
	chunks?: FoldChunk[];
}

export interface CertifiedFoldResult {
	state: bigint;
	chunks: number;
	tasks: number;
}

/**
 * Folds `input`, a view of `memory`, through the certified kernel on the workers of `pool`, which
 * must run `serveCertified` on that memory. Every chunk runs once from state zero, in place, and
 * the model turns the end states into the state of the serial call. Nothing is compared or run
 * twice: the certificate is what makes the result equal the serial one, so the input must be
 * clear of the memory the proof depends on, which this checks.
 */
export function foldCertified(
	pool: TaskPool,
	input: Uint8Array,
	memory: WebAssembly.Memory,
	certificate: StreamCertificate,
	options: CertifiedFoldOptions = {}
): CertifiedFoldResult {
	if (certificate.output)
		throw new RangeError('the kernel rewrites its input: use reconstructCertified');
	const run = open(pool, input, memory, certificate, options);
	if (!run.chunks) return { state: run.whole(), chunks: 1, tasks: run.tasks() };
	const handles = run.chunks.map((chunk) => run.submit(0n, chunk));
	let state = run.initial;
	run.chunks.forEach((chunk, i) => {
		state = predictEnd(
			certificate.model,
			state,
			chunk.end - chunk.start,
			run.endOf(handles[i]!)
		);
	});
	return { state, chunks: run.chunks.length, tasks: run.tasks() };
}

/** Checks the input and the chunk ranges, and returns the calls that submit and join one chunk. */
function open(
	pool: TaskPool,
	input: Uint8Array,
	memory: WebAssembly.Memory,
	certificate: StreamCertificate,
	options: CertifiedFoldOptions
) {
	if (input.buffer !== memory.buffer)
		throw new RangeError('the input is not a view of the memory');
	if (!guardInput(certificate, memory.buffer.byteLength, input.byteOffset, input.length))
		throw new RangeError(
			'the input leaves the memory or overlaps what the certificate depends on'
		);
	const initial = BigInt.asUintN(certificate.model.bits, options.initial ?? 0n);
	let tasks = 0;
	const submit = (state: bigint, chunk: FoldChunk) => {
		tasks++;
		return pool.submit(
			`${CERTIFIED_TASK}:${state.toString(16)}`,
			input.subarray(chunk.start, chunk.end),
			{ share: true }
		);
	};
	const endOf = (handle: string) => {
		const part = pool.join(handle).bytes;
		return new DataView(part.buffer, part.byteOffset).getBigUint64(0, true);
	};
	// the serial call itself, which also covers a zero length call that is not the identity
	const whole = () => endOf(submit(initial, { start: 0, end: input.length }));
	const base = { initial, submit, endOf, whole, tasks: () => tasks };
	if (input.length === 0 || (options.chunks?.length ?? 0) === 1)
		return { ...base, chunks: undefined };
	const chunks = options.chunks ?? chunkRanges(input.length, pool.width, 1);
	if (chunks.length === 1) return { ...base, chunks: undefined };
	let at = 0;
	for (const [i, chunk] of chunks.entries()) {
		if (chunk.start !== at || chunk.end <= chunk.start)
			throw new RangeError(`chunk ${i} is not contiguous`);
		at = chunk.end;
	}
	if (at !== input.length) throw new RangeError(`chunks cover ${at} of ${input.length} bytes`);
	return { ...base, chunks };
}

/**
 * The state after `length` bytes from state zero, for a step that ignores its byte: the doubling
 * that builds a chunk's offset needs no run of the kernel.
 */
function zeroRun(certificate: StreamCertificate, length: number): bigint {
	const { model, output } = certificate;
	let power = output!.step!;
	let size = 1;
	let result = 0n;
	for (let n = length; n > 0; n = Math.floor(n / 2)) {
		if (n % 2 === 1) result = predictEnd(model, result, size, power);
		power = predictEnd(model, power, size, power);
		size *= 2;
	}
	return result;
}

/**
 * Runs a certified kernel that rewrites its input in place, one call per chunk on the workers of
 * `pool`. Chunks may start without the ones before them, because the byte step ignores the bytes
 * and the model gives the state at every chunk start, so each chunk runs once and writes its own
 * bytes. A chunk that ends in a state the model did not predict means the certificate does not
 * describe the kernel: the input is already rewritten, so this throws instead of returning.
 */
export function reconstructCertified(
	pool: TaskPool,
	input: Uint8Array,
	memory: WebAssembly.Memory,
	certificate: StreamCertificate,
	options: CertifiedFoldOptions = {}
): CertifiedFoldResult {
	if (certificate.output?.step === undefined)
		throw new RangeError(
			'the certificate does not let chunks start without the ones before them'
		);
	const run = open(pool, input, memory, certificate, options);
	if (!run.chunks) return { state: run.whole(), chunks: 1, tasks: run.tasks() };
	const starts = [run.initial];
	for (const chunk of run.chunks)
		starts.push(
			predictEnd(
				certificate.model,
				starts[starts.length - 1]!,
				chunk.end - chunk.start,
				zeroRun(certificate, chunk.end - chunk.start)
			)
		);
	const handles = run.chunks.map((chunk, i) => run.submit(starts[i]!, chunk));
	handles.forEach((handle, i) => {
		if (run.endOf(handle) !== starts[i + 1])
			throw new Error(`chunk ${i} ended in a state the certificate did not predict`);
	});
	return { state: starts[starts.length - 1]!, chunks: run.chunks.length, tasks: run.tasks() };
}
