export interface Call {
	export: string;
	args: number[];
}

export interface Api {
	exports: WebAssembly.Exports;
	memory: WebAssembly.Memory;
}

export interface Case {
	name: string;
	/** runs untimed on raw exports and returns the timed calls */
	prepare(api: Api): Call[];
	/** runs untimed after the memory digest */
	finish?(api: Api): void;
}

export interface Report {
	workers: number;
	regions: number;
	mode: string;
	reason?: string;
	/** lane run messages and the JSON bytes they carried; shared memory is not copied */
	messages?: number;
	copiedBytes?: number;
}

export interface Arm {
	name: string;
	api: Api;
	run(calls: Call[]): Promise<{ values: unknown[]; report?: Report }>;
}

export interface Spec {
	name: string;
	cases: Case[];
}

export interface Options {
	pairs: number;
	warmup: number;
	/** stop starting new cases once this much time has passed since the first sample */
	budgetMs: number;
	now?: () => number;
	/** a slower, stronger digest of the whole memory, taken once per case and arm */
	fullDigest?: (api: Api) => Promise<string>;
}

export type Row = Record<string, any>;

const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');

/** Two multiplicative lanes over every 32-bit word of the memory, plus the length. */
export function fastHash(bytes: Uint8Array): string {
	const length = bytes.byteLength;
	const words = new Uint32Array(bytes.buffer, bytes.byteOffset, length >>> 2);
	let a = 0x811c9dc5;
	let b = 0x9e3779b9;
	for (let index = 0; index < words.length; index++) {
		const word = words[index]!;
		a = Math.imul(a ^ word, 0x01000193);
		b = Math.imul(b + word, 0x85ebca6b) ^ (b >>> 15);
	}
	for (let index = length & ~3; index < length; index++) {
		a = Math.imul(a ^ bytes[index]!, 0x01000193);
		b = Math.imul(b + bytes[index]!, 0x85ebca6b) ^ (b >>> 15);
	}
	return `${hex(a)}${hex(b)}${hex(length)}`;
}

const text = (values: unknown[]) =>
	JSON.stringify(values, (_, value) => (typeof value === 'bigint' ? `${value}n` : value));

/** Runs every arm over every case in rotated rounds and compares each arm's whole memory and returns. */
export async function measureConsumer(
	spec: Spec,
	arms: Arm[],
	options: Options,
	emit: (row: Row) => void
) {
	const now = options.now ?? (() => performance.now());
	const started = now();
	const completed: Record<string, number> = {};
	let truncated = false;
	for (const item of spec.cases) {
		if (now() - started > options.budgetMs) {
			truncated = true;
			break;
		}
		const digests = new Map<string, string>();
		for (let round = 0 - options.warmup; round < options.pairs; round++) {
			digests.clear();
			for (let turn = 0; turn < arms.length; turn++) {
				const arm = arms[(turn + round + options.warmup) % arms.length]!;
				const calls = item.prepare(arm.api);
				const begin = now();
				const result = await arm.run(calls);
				const wallMs = now() - begin;
				const digest = `${fastHash(new Uint8Array(arm.api.memory.buffer))}:${text(result.values)}`;
				const full =
					round === 0 && options.fullDigest
						? await options.fullDigest(arm.api)
						: undefined;
				item.finish?.(arm.api);
				digests.set(arm.name, digest);
				if (round < 0) continue;
				emit({
					kind: 'sample',
					consumer: spec.name,
					name: `${spec.name}/${item.name}`,
					arm: arm.name,
					round,
					calls: calls.length,
					wallMs,
					digest: digest.slice(0, 24),
					sha256: full,
					dispatched: result.report,
					passed: true
				});
			}
			if (new Set(digests.values()).size !== 1) {
				const detail = Object.fromEntries(
					[...digests].map(([name, value]) => [name, value.slice(0, 24)])
				);
				emit({
					kind: 'mismatch',
					name: `${spec.name}/${item.name}`,
					round,
					digests: detail
				});
				throw new Error(
					`${spec.name}/${item.name} round ${round}: memory or returns differ`
				);
			}
			if (round >= 0) completed[item.name] = round + 1;
		}
	}
	emit({ kind: 'done', consumer: spec.name, truncated, completed, elapsedMs: now() - started });
	return { truncated, completed };
}
