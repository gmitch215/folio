import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { prepare } from '../../src/compiler.ts';
import { inlineEntryBytes, lowerInline } from '../../src/inline.ts';
import { transaction } from '../../src/transaction.ts';

const root = new URL('../../', import.meta.url).pathname;
const READ = 64,
	WRITE = 32,
	PAGE = 65536;
const align = (value: number, to: number) => Math.ceil(value / to) * to;
const sha = (view: Uint8Array) => createHash('sha256').update(view).digest('hex');

export interface Call {
	name: string;
	args: number[];
}

/** One module and the calls to compare. `fresh` re-seeds a new memory for every call. */
export interface Subject {
	id: string;
	bytes: Uint8Array;
	/** Bytes of memory the program owns; the arena sits above it. */
	program: number;
	shared: boolean;
	imports?: (memory: WebAssembly.Memory) => WebAssembly.Imports;
	seed: (memory: Uint8Array) => void;
	/** Calls that run first, are not compared and are not measured. */
	setup?: string[];
	calls: Call[];
	fresh: boolean;
}

export interface CallReport {
	subject: string;
	call: string;
	/** Result, trap and the program bytes equal to the native run. */
	equal: boolean;
	trap: boolean;
	readGranules: number;
	writeGranules: number;
	undoEntries: number;
	/** Changed program bytes the write marks do not cover. */
	changedUnmarked: number;
	/** Reads and writes of the footprint arm that the inline marks miss; null when there is none. */
	hostCall: {
		arm: string;
		readsMissed: number;
		writesMissed: number;
		/** Host-call footprint granules the independent tracer lacks; checks the tracer. */
		tracerMissed: number;
	} | null;
	oracle: {
		reads: number;
		writes: number;
		readsMissed: number;
		writesMissed: number;
	} | null;
}

interface Arena {
	rb: number;
	wb: number;
	lp: number;
	ll: number;
	sa: number;
	rsize: number;
	wsize: number;
	pages: number;
}

// the arena follows the program; bitmaps cover every address below the end of memory
export function arenaFor(program: number, entries: number): Arena {
	const base = align(program, PAGE);
	let total = base;
	for (;;) {
		const rsize = align(Math.ceil(total / (READ * 8)), 64);
		const wsize = align(Math.ceil(total / (WRITE * 8)), 64);
		const log = align(entries * inlineEntryBytes(WRITE), 64);
		const needed = align(base + rsize + wsize + log + 64, PAGE);
		if (needed <= total)
			return {
				rb: base,
				wb: base + rsize,
				lp: base + rsize + wsize,
				ll: base + rsize + wsize + log,
				sa: base + rsize + wsize + log,
				rsize,
				wsize,
				pages: total / PAGE
			};
		total = Math.max(needed, total + PAGE);
	}
}

const granules = (view: Uint8Array, base: number, size: number) => {
	const out = new Set<number>();
	for (let i = 0; i < size; i++) {
		const byte = view[base + i]!;
		if (byte) for (let b = 0; b < 8; b++) if ((byte >> b) & 1) out.add(i * 8 + b);
	}
	return out;
};

function memoryFor(subject: Subject, pages: number) {
	return new WebAssembly.Memory({
		initial: pages,
		maximum: Math.max(pages, subject.shared ? pages : 1024),
		shared: subject.shared
	});
}

function instantiate(subject: Subject, bytes: Uint8Array, pages: number) {
	const memory = memoryFor(subject, pages);
	const imports = subject.imports?.(memory) ?? { env: { memory } };
	const instance = new WebAssembly.Instance(
		new WebAssembly.Module(Uint8Array.from(bytes)),
		imports
	);
	const view = new Uint8Array(memory.buffer);
	subject.seed(view);
	return { memory, view, exports: instance.exports as Record<string, any> };
}

const outcome = (run: () => unknown) => {
	try {
		return { result: String(run()), trap: false };
	} catch (error) {
		return {
			result: error instanceof WebAssembly.RuntimeError ? 'trap' : String(error),
			trap: true
		};
	}
};

// binaryen's own host-call memory tracer: independent of lowerInline, loads and stores only
function oracleModule(bytes: Uint8Array) {
	const module = binaryen.readBinary(bytes);
	const compactImports = (binaryen.Features as unknown as { CompactImports: number })
		.CompactImports;
	module.setFeatures(binaryen.Features.All & ~compactImports);
	module.runPasses(['instrument-memory']);
	try {
		return module.emitBinary();
	} finally {
		module.dispose();
	}
}

/** Runs every call of the subject natively and lowered and reports what differs. */
export function compareInline(
	subject: Subject,
	options: { oracle?: boolean; entries?: number } = {}
): CallReport[] {
	const arena = arenaFor(subject.program, options.entries ?? subject.program / WRITE);
	const lowered = lowerInline(subject.bytes, { requireShared: subject.shared });
	const oracleBytes = options.oracle === false ? undefined : oracleModule(subject.bytes);
	const prepared = subject.fresh && subject.shared ? prepare(subject.bytes) : undefined;
	const reports: CallReport[] = [];
	const hostCall = (call: Call) => {
		if (!prepared?.transactional) return undefined;
		const memory = memoryFor(subject, arena.pages);
		const active = transaction(memory, 1 << 30);
		const host = {
			load: active.load,
			store: active.store,
			load64: active.load64,
			store64: active.store64,
			copy: active.copy,
			fill: active.fill,
			exhausted: () => {
				throw new Error('fuel');
			}
		};
		const instance = new WebAssembly.Instance(
			new WebAssembly.Module(Uint8Array.from(prepared.transactional)),
			{
				env: { memory },
				folio: host
			}
		);
		subject.seed(new Uint8Array(memory.buffer));
		(instance.exports.__folio_set_fuel as CallableFunction)(0x7fffffff);
		let error: unknown;
		try {
			(instance.exports[call.name] as CallableFunction)(...call.args);
		} catch (caught) {
			error = caught;
		}
		const done = active.result(undefined, error);
		return {
			reads: new Set(done.reads.map((at) => Math.floor(at / READ))),
			writes: new Set(done.writes.map(([at]) => Math.floor(at / WRITE)))
		};
	};
	let native: ReturnType<typeof instantiate> | undefined,
		inline: ReturnType<typeof instantiate> | undefined,
		trace: ReturnType<typeof instantiate> | undefined,
		recording = false;
	const oracleReads = new Set<number>(),
		oracleWrites = new Set<number>();
	const open = () => {
		native = instantiate(subject, subject.bytes, arena.pages);
		inline = instantiate(subject, lowered, arena.pages);
		if (oracleBytes) {
			const note =
				(set: Set<number>, size: number) =>
				(_id: number, bytes: number, offset: number, ptr: number) => {
					if (recording) {
						const at = (ptr + offset) >>> 0;
						set.add(Math.floor(at / size));
						set.add(Math.floor((at + bytes - 1) / size));
					}
					return ptr;
				};
			const memory = memoryFor(subject, arena.pages);
			const base = subject.imports?.(memory) ?? { env: { memory } };
			const env: Record<string, any> = { ...(base.env as object) };
			for (const item of WebAssembly.Module.imports(
				new WebAssembly.Module(Uint8Array.from(oracleBytes))
			)) {
				if (item.kind !== 'function' || item.name in env) continue;
				if (item.name === 'load_ptr') env[item.name] = note(oracleReads, READ);
				else if (item.name === 'store_ptr') env[item.name] = note(oracleWrites, WRITE);
				else env[item.name] = (...args: number[]) => args[1];
			}
			const instance = new WebAssembly.Instance(
				new WebAssembly.Module(Uint8Array.from(oracleBytes)),
				{
					...base,
					env
				}
			);
			const view = new Uint8Array(memory.buffer);
			subject.seed(view);
			trace = { memory, view, exports: instance.exports as Record<string, any> };
		}
		const x = inline.exports;
		const arm = (ex: Record<string, any>) => {
			ex.__folio_rb.value = arena.rb;
			ex.__folio_wb.value = arena.wb;
			ex.__folio_lp.value = arena.lp;
			ex.__folio_ll.value = arena.ll;
			ex.__folio_sa.value = arena.sa;
		};
		arm(x);
		for (const name of subject.setup ?? []) {
			native.exports[name]!();
			x[name]!();
			trace?.exports[name]!();
		}
	};
	const reset = () => {
		const x = inline!.exports;
		inline!.view.fill(0, arena.rb, arena.lp);
		x.__folio_lp.value = arena.lp;
		new Int32Array(inline!.memory.buffer)[arena.sa / 4] = 0;
	};
	if (!subject.fresh) open();
	for (const call of subject.calls) {
		if (subject.fresh) open();
		const before = Uint8Array.from(inline!.view.subarray(0, subject.program));
		reset();
		oracleReads.clear();
		oracleWrites.clear();
		const want = outcome(() => native!.exports[call.name]!(...call.args));
		const got = outcome(() => inline!.exports[call.name]!(...call.args));
		recording = true;
		if (trace) outcome(() => trace!.exports[call.name]!(...call.args));
		recording = false;
		const after = inline!.view.subarray(0, subject.program);
		const nativeView = native!.view.subarray(0, subject.program);
		const equal =
			want.trap === got.trap &&
			(want.trap || want.result === got.result) &&
			sha(after) === sha(nativeView);
		const x = inline!.exports;
		const reads = granules(inline!.view, arena.rb, arena.rsize);
		const writes = granules(inline!.view, arena.wb, arena.wsize);
		const undoEntries = (x.__folio_lp.value - arena.lp) / inlineEntryBytes(WRITE);
		let changedUnmarked = 0;
		for (let at = 0; at < subject.program; at++)
			if (after[at] !== before[at] && !writes.has(Math.floor(at / WRITE))) changedUnmarked++;
		const missed = (set: Set<number>, have: Set<number>) =>
			[...set].filter((granule) => !have.has(granule)).length;
		const host = hostCall(call);
		reports.push({
			subject: subject.id,
			call: `${call.name}(${call.args.join(',')})`,
			equal,
			trap: want.trap,
			readGranules: reads.size,
			writeGranules: writes.size,
			undoEntries,
			changedUnmarked,
			hostCall: host
				? {
						arm: 'transaction',
						readsMissed: missed(host.reads, reads),
						writesMissed: missed(host.writes, writes),
						tracerMissed: oracleBytes
							? missed(host.reads, oracleReads) + missed(host.writes, oracleWrites)
							: 0
					}
				: null,
			oracle: oracleBytes
				? {
						reads: oracleReads.size,
						writes: oracleWrites.size,
						readsMissed: missed(oracleReads, reads),
						writesMissed: missed(oracleWrites, writes)
					}
				: null
		});
	}
	return reports;
}

// #region subjects
const pattern = (view: Uint8Array) => {
	for (let at = 0x1000; at < 0x4000; at++) view[at] = (at * 31 + 7) & 255;
};
const read = (path: string) => new Uint8Array(readFileSync(root + path));

export function fixtureSubjects(): Subject[] {
	const of = (id: string, calls: [string, ...number[]][]): Subject => ({
		id,
		bytes: read(`build/${id}.wasm`),
		program: 0x4000,
		shared: true,
		seed: pattern,
		calls: calls.map(([name, ...args]) => ({ name, args })),
		fresh: true
	});
	return [
		of('fixture', [
			['mix', 0x2000, 3],
			['program', 0x2000, 512, 2],
			['dependent_program', 0x2004, 500],
			['aliased_program', 0x2000, 6, 1],
			['division_program', 0x2000, 300, 3],
			['increment', 0x2000],
			['copy_word', 0x2040, 0x2000],
			['trap_after_write', 0x2000]
		]),
		of('generalized', [['main', 0x2000, 512, 3]]),
		of('sharing', [
			['read', 0x2000],
			['write', 0x2000, 5],
			['add', 0x2000, 3]
		])
	];
}

export function corpusSubjects(): Subject[] {
	const directory = root + 'build/research/corpus/artifacts/';
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((file) => file.endsWith('.wasm'))
		.sort()
		.map((file) => {
			const bytes = new Uint8Array(readFileSync(directory + file));
			const info = binaryen.readBinary(bytes);
			const initial = info.getMemoryInfo().initial;
			info.dispose();
			return {
				id: file.replace(/\.wasm$/, ''),
				bytes,
				program: initial * PAGE,
				shared: false,
				imports: (memory: WebAssembly.Memory) => ({
					env: {
						memory,
						sin: Math.sin,
						cos: Math.cos,
						floor: Math.floor,
						sqrt: Math.sqrt
					}
				}),
				seed: () => {},
				setup: ['initialize'],
				calls: [{ name: 'entry', args: [] }],
				fresh: false
			};
		});
}

export const BLAKE3 = 'results/corpus/blake3-consumer/blake3-hash-all.wasm';
const BASE = 1 << 20,
	DATA = BASE + PAGE;

// n inputs of the given sizes behind a table of (offset, length) pairs, as blake3-bench.ts places them
export function blake3Subject(sizes: number[]): Subject {
	const out = BASE + 8 * sizes.length;
	return {
		id: 'blake3-hash-all',
		bytes: read(BLAKE3),
		program:
			align(
				sizes.reduce((sum, size) => sum + size + 64, DATA),
				PAGE
			) + PAGE,
		shared: false,
		seed: (view) => {
			const words = new Uint32Array(view.buffer, BASE, 2 * sizes.length);
			let at = DATA;
			sizes.forEach((size, index) => {
				let state = (0x9e3779b9 ^ Math.imul(index + 1, 2654435761)) | 0;
				for (let i = 0; i < size; i++) {
					state ^= state << 13;
					state ^= state >>> 17;
					state ^= state << 5;
					view[at + i] = state & 255;
				}
				words[2 * index] = at;
				words[2 * index + 1] = size;
				at += size + 64;
			});
		},
		calls: [{ name: 'hash_all', args: [BASE, sizes.length, out] }],
		fresh: true
	};
}
// #endregion

// #region single thread cost
/** Median wall time of one hash_all over one input of `size` bytes, native and lowered. */
export function singleCost(size: number, repetitions = 40, warmups = 5) {
	const subject = blake3Subject([size]);
	const arena = arenaFor(subject.program, 1 << 14);
	const times = (bytes: Uint8Array, lowered: boolean) => {
		const { view, exports: x } = instantiate(subject, bytes, arena.pages);
		if (lowered) {
			x.__folio_rb.value = arena.rb;
			x.__folio_wb.value = arena.wb;
			x.__folio_ll.value = arena.ll;
			x.__folio_sa.value = arena.sa;
		}
		const samples: number[] = [];
		let entries = 0;
		for (let round = -warmups; round < repetitions; round++) {
			if (lowered) {
				view.fill(0, arena.rb, arena.wb + arena.wsize);
				x.__folio_lp.value = arena.lp;
			}
			const start = performance.now();
			x.hash_all(BASE, 1, BASE + 8);
			if (round >= 0) samples.push(performance.now() - start);
			if (lowered) entries = (x.__folio_lp.value - arena.lp) / inlineEntryBytes(WRITE);
		}
		samples.sort((a, b) => a - b);
		return { min: samples[0]!, median: samples[samples.length >> 1]!, entries };
	};
	const load = loadavg();
	const native = times(subject.bytes, false);
	const marked = times(lowerInline(subject.bytes, { requireShared: false }), true);
	return { size, load, native, marked, ratio: marked.median / native.median };
}
// #endregion

if (import.meta.main) {
	const [mode = 'all', ...rest] = process.argv.slice(2);
	const print = (value: unknown) => console.log(JSON.stringify(value));
	if (mode === 'cost') {
		for (const size of (rest[0] ?? '65536,1048576,4194304').split(',').map(Number))
			print(singleCost(size));
	} else {
		const subjects =
			mode === 'fixtures'
				? fixtureSubjects()
				: mode === 'corpus'
					? corpusSubjects()
					: mode === 'blake3'
						? [
								blake3Subject([
									0, 1, 63, 64, 1023, 1024, 1025, 2048, 4097, 8192, 31745, 102400
								])
							]
						: [
								...fixtureSubjects(),
								...corpusSubjects(),
								blake3Subject([
									0, 1, 63, 64, 1023, 1024, 1025, 2048, 4097, 8192, 31745, 102400
								])
							];
		for (const subject of subjects.filter((s) => !rest.length || rest.includes(s.id))) {
			const start = performance.now();
			for (const report of compareInline(subject)) print(report);
			print({
				subject: subject.id,
				ms: Math.round(performance.now() - start),
				load: loadavg()
			});
		}
	}
}
