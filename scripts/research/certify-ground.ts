import { predictEnd } from '../../src/affine.ts';
import type { StreamCertificate } from '../../src/certify.ts';

// ground truth for a stream certificate: execution on real instances, never the certifier's own arithmetic

const OFFSET = 1 << 20;
const MAXLEN = 1048576;
const pattern = (kind: number) =>
	Uint8Array.from({ length: MAXLEN + 64 }, (_, k) =>
		kind === 0
			? (Math.imul(k, 2654435761) ^ (k >>> 8)) & 255
			: kind === 1
				? 0
				: kind === 2
					? 255
					: k & 255
	);
const inputs = [0, 1, 2, 3].map(pattern);

export const GROUND_LENGTHS = [
	1, 2, 3, 7, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255, 256, 257, 1023, 1025, 4095, 4097, 65535,
	65537, 100000, 262143, 262144, 1048576
];

/** Returns the first disagreement between the certificate and execution, or an empty string. */
export function groundTruth(
	bytes: Uint8Array,
	certificate: StreamCertificate,
	lengths: number[] = GROUND_LENGTHS,
	maxOffset = OFFSET
): string {
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	const bits = certificate.bits;
	const m = (1n << BigInt(bits)) - 1n;
	const pages = Math.ceil((maxOffset + MAXLEN + 128) / 65536);
	const fresh = (kind: number, pointer = maxOffset) => {
		const instance = new WebAssembly.Instance(mod, {});
		const memory = instance.exports.memory as WebAssembly.Memory;
		if (memory.buffer.byteLength < pages * 65536)
			memory.grow(pages - memory.buffer.byteLength / 65536);
		new Uint8Array(memory.buffer, pointer, MAXLEN + 64).set(inputs[kind]!);
		const fn = instance.exports[certificate.entry] as (
			...args: (number | bigint)[]
		) => number | bigint;
		const { layout } = certificate;
		return (state: bigint, at: number, len: number): bigint => {
			const args: (number | bigint)[] = [0, 0, 0];
			args[layout.state] =
				bits === 32 ? Number(BigInt.asIntN(32, state)) : BigInt.asIntN(64, state);
			args[layout.ptr] = pointer + at;
			args[layout.len] = len;
			return BigInt.asUintN(bits, BigInt(fn(...args)));
		};
	};
	for (const len of lengths) {
		if (len > MAXLEN) continue;
		for (const kind of len > 65537 ? [0] : [0, 1, 2, 3])
			for (const s of [0n, 1n, 0x80000000n & m, 0xffffffffn & m, 0xdeadbeefcafef00dn & m]) {
				let whole: bigint;
				try {
					whole = fresh(kind)(s, 0, len);
				} catch {
					return `trap at length ${len}`;
				}
				// a second call on the same instance must not depend on what the first left behind,
				// unless the call rewrites its input, which is the first thing it leaves behind
				const twice = fresh(kind);
				twice(s, 0, len);
				if (!certificate.output && twice(s, 0, len) !== whole)
					return `second call differs at length ${len}`;
				for (const cut of [1, Math.floor(len / 3), Math.floor(len / 2), len - 1]) {
					if (cut < 1 || cut >= len) continue;
					const call = fresh(kind);
					if (call(call(s, 0, cut), cut, len - cut) !== whole)
						return `chain length ${len} cut ${cut} state ${s} pattern ${kind}`;
				}
				if (len < 2) continue;
				for (const width of [2, 3, 5, 8]) {
					let combined = s & m;
					for (let k = 0; k < width; k++) {
						const from = Math.floor((k * len) / width);
						const to = Math.floor(((k + 1) * len) / width);
						if (to === from) continue;
						combined = predictEnd(
							certificate.model,
							combined,
							to - from,
							fresh(kind)(0n, from, to - from)
						);
					}
					if (combined !== whole)
						return `model length ${len} width ${width} state ${s} pattern ${kind}`;
				}
			}
		if (len <= 65537)
			for (const shift of [1, 3, 5, 7]) {
				const moved = fresh(0, maxOffset + 4096 + shift);
				const base = fresh(0);
				if (moved(1n, 0, len) !== base(1n, 0, len))
					return `pointer shift ${shift} length ${len}`;
			}
	}
	return certificate.output ? outputGround(bytes, certificate, lengths, maxOffset) : '';
}

/**
 * Ground truth for a certificate that says the call rewrites its input: the bytes after one call,
 * after two calls cut anywhere, and after chunks run in reverse order from the states a serial run
 * reaches, must all be equal, and nothing outside the input may change.
 */
export function outputGround(
	bytes: Uint8Array,
	certificate: StreamCertificate,
	lengths: number[],
	pointer = OFFSET
): string {
	const mod = new WebAssembly.Module(Uint8Array.from(bytes));
	const bits = certificate.bits;
	const { layout } = certificate;
	const pages = Math.ceil((pointer + MAXLEN + 128) / 65536);
	const make = (kind: number) => {
		const instance = new WebAssembly.Instance(mod, {});
		const memory = instance.exports.memory as WebAssembly.Memory;
		if (memory.buffer.byteLength < pages * 65536)
			memory.grow(pages - memory.buffer.byteLength / 65536);
		new Uint8Array(memory.buffer, pointer, MAXLEN + 64).set(inputs[kind]!);
		const fn = instance.exports[certificate.entry] as (
			...args: (number | bigint)[]
		) => number | bigint;
		return {
			memory,
			call(state: bigint, at: number, len: number): bigint {
				const args: (number | bigint)[] = [0, 0, 0];
				args[layout.state] =
					bits === 32 ? Number(BigInt.asIntN(32, state)) : BigInt.asIntN(64, state);
				args[layout.ptr] = pointer + at;
				args[layout.len] = len;
				return BigInt.asUintN(bits, BigInt(fn(...args)));
			}
		};
	};
	const region = (m: WebAssembly.Memory, len: number) =>
		Buffer.from(m.buffer, pointer, len).toString('hex');
	const m = (1n << BigInt(bits)) - 1n;
	for (const len of lengths) {
		if (len > 65537) continue;
		for (const kind of [0, 1, 2, 3])
			for (const s of [0n, 1n, 0x80000000n & m, 0xffffffffn & m, 0xdeadbeefcafef00dn & m]) {
				const untouched = make(kind);
				const whole = make(kind);
				const end = whole.call(s, 0, len);
				const out = region(whole.memory, len);
				const before = Buffer.from(untouched.memory.buffer);
				const after = Buffer.from(whole.memory.buffer);
				if (
					Buffer.compare(before.subarray(0, pointer), after.subarray(0, pointer)) ||
					Buffer.compare(before.subarray(pointer + len), after.subarray(pointer + len))
				)
					return `output length ${len} writes outside the input`;
				for (const cut of [1, Math.floor(len / 2), len - 1]) {
					if (cut < 1 || cut >= len) continue;
					const two = make(kind);
					two.call(two.call(s, 0, cut), cut, len - cut);
					if (region(two.memory, len) !== out)
						return `output length ${len} cut ${cut} state ${s} pattern ${kind}`;
				}
				if (len < 2) continue;
				for (const width of [2, 3, 5]) {
					const serial = make(kind);
					const starts = [s & m];
					const edges: number[] = [0];
					for (let k = 1; k <= width; k++) edges.push(Math.floor((k * len) / width));
					for (let k = 0; k < width; k++)
						starts.push(
							edges[k + 1]! > edges[k]!
								? serial.call(starts[k]!, edges[k]!, edges[k + 1]! - edges[k]!)
								: starts[k]!
						);
					const reverse = make(kind);
					for (let k = width - 1; k >= 0; k--)
						if (edges[k + 1]! > edges[k]!)
							reverse.call(starts[k]!, edges[k]!, edges[k + 1]! - edges[k]!);
					if (region(reverse.memory, len) !== out || starts[width] !== end)
						return `output length ${len} width ${width} state ${s} pattern ${kind}`;
				}
			}
	}
	return '';
}
