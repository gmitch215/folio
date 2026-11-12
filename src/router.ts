import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
	foldCertified,
	installPrefill,
	reconstructCertified,
	shareCertified
} from './certified.ts';
import {
	certifyStream,
	CHECKER,
	type CertificateRefusal,
	type StreamCertificate
} from './certify.ts';
import { iterationAdmissionConstants } from './iteration-admission.ts';
import { Folio } from './node.ts';
import { OwnershipSlices } from './ownership-slices.ts';
import {
	certifyOwnership,
	guardRecords,
	OWNERSHIP_CHECKER,
	type OwnershipCertificate,
	type OwnershipOptions,
	type OwnershipRefusal
} from './ownership.ts';
import { decodeValues, encodeValues, sharedMemoryImport } from './slices.ts';
import { TaskPool } from './tasks.ts';

/** @since 1.1.0 */
export const ROUTER_VERSION = 'folio-router-2';

/** `summary` is the certified stream fold, `window` the certified private window on slices. */
export type Route = 'summary' | 'window' | 'explicit' | 'tracked' | 'serial';

/** One value per ablation arm. `serial` never leaves the owner thread. */
export type RouterMode = 'serial' | 'w1' | 'w2' | 'independent' | 'shared' | 'router';

/** Every decision names one of these. The first four are routes taken, the rest are refusals. */
export const ROUTER_REASONS = [
	'certified-summary',
	'certified-window',
	'explicit-runner',
	'tracked-eligible',
	'mode-serial',
	'single-worker',
	'below-floor',
	'dispatch-lost',
	'not-a-stream',
	'stream-refused',
	'no-route-in-mode',
	'no-certificate',
	'allocator-state',
	'shared-state',
	'unclassified-dependency',
	'wild-store',
	'layout-overlap',
	'assumption-unasserted',
	'tracked-ineligible',
	'memory-not-imported'
] as const;

export type RouterReason = (typeof ROUTER_REASONS)[number];

/** A single call over `len` bytes of one stream: `entry(state, ptr, len)`. */
export interface StreamCall {
	kind: 'stream';
	entry: string;
	ptr: number;
	len: number;
}

/** A loop of independent calls: `entry(...args(0, count))` equals the serial program. */
export interface RecordsCall {
	kind: 'records';
	entry: string;
	count: number;
	args: (from: number, to: number) => (number | bigint)[];
	/** Every region the records touch, for the window guard. */
	regions: [number, number][];
	/**
	 * The regions the records write outside any window. The list must name every range the records
	 * write: a range left out keeps the writes of the records after a trap, and the serial replay does
	 * not undo them.
	 */
	writes: [number, number][];
}

export type RouterCall = StreamCall | RecordsCall;

/** What the caller knows about the program that no static test can establish. */
export interface RouterAssumptions {
	/** Every host import returns the same value for the same arguments. */
	importsDeterministic?: boolean;
	/** Nothing reads the stack zone or the arena past the program memory after the call. */
	residueUnobserved?: boolean;
}

export interface RouterConstants {
	/** Serial time of the remaining records below which the tracked and explicit routes stay serial. */
	trackedFloorMs: number;
	/** The same for the window route. */
	windowFloorMs: number;
	/** Stream length below which the summary route stays serial. */
	summaryMinBytes: number;
}

/**
 * The tracked floor is the admission constants of the iteration route (fitted on the blake3 sweep,
 * `results/corpus/iteration-admission`). The window floor is the smallest serial time at which all
 * five paired runs of `aes-cbc-decrypt-shared` at 8 workers beat serial by 1.25 (4 records, 0.82
 * ms; 3 records at 0.69 ms did not). The summary length is the smallest size at which every paired
 * run of two hand stream modules did (1 MiB; 256 KiB did not). One driver and two hand modules,
 * Mac, loaded: `scratchpad/v11/w3/dev/fit-*.jsonl`.
 */
export const routerConstants: RouterConstants = {
	trackedFloorMs: iterationAdmissionConstants.fixedMs * iterationAdmissionConstants.margin,
	windowFloorMs: 0.8,
	summaryMinBytes: 1 << 20
};

/** Records a first call runs serially to estimate the serial time of one record. */
const PROBE_RECORDS = 4;

/** The per-record serial estimate after a tracked call: the lower of it and that call's plain first iteration. @internal */
export const lowerEstimate = (current: number, plainMs: number | undefined): number =>
	plainMs !== undefined && plainMs > 0 && plainMs < current ? plainMs : current;

export interface RouterOptions {
	mode: RouterMode;
	/** Initial pages of the memory the router allocates. */
	pages: number;
	/** Declared maximum of the shared memory a records call runs on; the module's own limit if lower. */
	maxPages?: number;
	workers?: number;
	cache?: CertificateCache;
	/** A module specifier or URL whose default export returns the imports besides the memory. */
	imports?: string | URL;
	assume?: RouterAssumptions;
	/** Runs the records on a route the caller built; chosen after the window route in `router` mode. */
	explicit?: (call: RecordsCall) => Promise<void>;
	/** Overrides for `routerConstants`; a sweep sets them to 0 to force a dispatch. */
	floors?: Partial<RouterConstants>;
	/** Certifier options that change a certificate, and so the cache key. */
	ownership?: OwnershipOptions;
}

export interface Consideration {
	route: Route;
	verdict: 'taken' | 'refused' | 'skipped';
	reason: RouterReason;
	detail: string;
}

export interface RouterDecision {
	route: Route;
	reason: RouterReason;
	detail: string;
	mode: RouterMode;
	/** Wall time of the analyses this decision ran. Zero when every answer came from the cache. */
	certifyMs: number;
	cacheHit: boolean;
	analyses: ('shape' | 'stream' | 'ownership')[];
	considered: Consideration[];
}

export interface RouterRun {
	/** The route that executed this call, which differs from the decision when the floor refuses. */
	route: Route;
	reason: RouterReason;
	wallMs: number;
	/** Time of the serial probe of record 0, on the call that measured it. */
	probeMs?: number;
	/** The stream's end state, for a stream call. */
	state?: bigint;
	/** The Folio report of a tracked call. */
	tracked?: { mode: string; reason?: string; iteration?: unknown };
}

// #region cache

type Slot = 'shape' | 'stream' | 'ownership';

interface Entry {
	shape?: ModuleShape;
	stream?: StreamCertificate | CertificateRefusal;
	ownership?: OwnershipCertificate | OwnershipRefusal;
	/** Wall time the analysis took on the call that filled the slot. */
	ms: Partial<Record<Slot, number>>;
}

const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/** The runtime a certificate was made on: a different engine or checker build is a different key. */
export const defaultBackend = () =>
	`node-${process.version}-${process.arch}-binaryen-${createRequire(import.meta.url)('binaryen/package.json').version}`;

/**
 * Certificates and refusals keyed by the SHA-256 of the module and a configuration key (backend,
 * checker and router versions, and the options that change a certificate). A refusal is stored
 * like a certificate, so a refused module costs a map lookup after the first call.
 * @since 1.1.0
 */
export class CertificateCache {
	readonly backend: string;
	readonly #entries = new Map<string, Entry>();
	hits = 0;
	misses = 0;

	constructor(options: { backend?: string } = {}) {
		this.backend = options.backend ?? defaultBackend();
	}

	get size(): number {
		return this.#entries.size;
	}

	key(bytes: Uint8Array, config: unknown): string {
		const versions = [this.backend, CHECKER, OWNERSHIP_CHECKER, ROUTER_VERSION];
		return `${sha(bytes)}:${sha(JSON.stringify([versions, config ?? null]))}`;
	}

	/** Returns the stored answer of `slot`, or makes, times and stores it. `ms` is 0 on a hit. */
	get<S extends Slot>(
		bytes: Uint8Array,
		config: unknown,
		slot: S,
		make: () => NonNullable<Entry[S]>
	): { value: NonNullable<Entry[S]>; ms: number; hit: boolean } {
		const key = this.key(bytes, config);
		const entry = this.#entries.get(key) ?? { ms: {} };
		this.#entries.set(key, entry);
		const stored = entry[slot];
		if (stored !== undefined) {
			this.hits++;
			return { value: stored as NonNullable<Entry[S]>, ms: 0, hit: true };
		}
		this.misses++;
		const started = performance.now();
		const value = make();
		const ms = performance.now() - started;
		(entry as Record<Slot, unknown>)[slot] = value;
		entry.ms[slot] = ms;
		return { value, ms, hit: false };
	}

	/** Wall time the analysis took when it filled the slot, for an offline certification report. */
	filledMs(bytes: Uint8Array, config: unknown, slot: Slot): number | undefined {
		return this.#entries.get(this.key(bytes, config))?.ms[slot];
	}

	serialize(): string {
		return encodeValues([...this.#entries]);
	}

	/** Loads what `serialize` wrote. Entries made under another backend never match a key. */
	load(text: string): void {
		for (const [key, entry] of decodeValues(text) as [string, Entry][])
			this.#entries.set(key, entry);
	}
}

// #endregion

// #region shape

export interface ModuleShape {
	valid: boolean;
	entryFound: boolean;
	entryParams: string[];
	entryResults: number;
	functionImports: number;
	memoryImported: boolean;
}

const TYPE_NAME = new Map<number, string>([
	[binaryen.i32, 'i32'],
	[binaryen.i64, 'i64'],
	[binaryen.f32, 'f32'],
	[binaryen.f64, 'f64']
]);

/** One decode of the module: what both certificate builders need to know before they start. */
export function analyzeModule(bytes: Uint8Array, entry: string): ModuleShape {
	const shape: ModuleShape = {
		valid: false,
		entryFound: false,
		entryParams: [],
		entryResults: 0,
		functionImports: 0,
		memoryImported: false
	};
	let compiled: WebAssembly.Module;
	try {
		compiled = new WebAssembly.Module(Uint8Array.from(bytes));
	} catch {
		return shape;
	}
	shape.valid = true;
	for (const item of WebAssembly.Module.imports(compiled)) {
		if (item.kind === 'function') shape.functionImports++;
		if (item.kind === 'memory') shape.memoryImported = true;
	}
	const module = binaryen.readBinary(Uint8Array.from(bytes));
	try {
		const exported = module.getExport(entry);
		if (exported) {
			const info = binaryen.getExportInfo(exported);
			if (info.kind === binaryen.ExternalFunction) {
				const fn = binaryen.getFunctionInfo(module.getFunction(info.value));
				shape.entryFound = true;
				shape.entryParams = binaryen
					.expandType(fn.params)
					.map((type) => TYPE_NAME.get(type) ?? 'other');
				shape.entryResults = binaryen.expandType(fn.results).length;
			}
		}
	} finally {
		module.dispose();
	}
	return shape;
}

const streamShaped = (s: ModuleShape) =>
	s.entryFound &&
	s.entryParams.length === 3 &&
	s.entryParams[1] === 'i32' &&
	s.entryParams[2] === 'i32' &&
	(s.entryParams[0] === 'i32' || s.entryParams[0] === 'i64') &&
	s.entryResults === 1;

const recordsShaped = (s: ModuleShape) =>
	s.entryFound &&
	s.entryParams.length >= 3 &&
	s.entryParams.slice(0, 3).every((t) => t === 'i32');

// #endregion

const MODE_ROUTES: Record<RouterMode, Route[]> = {
	serial: [],
	w1: ['summary'],
	w2: ['window'],
	independent: ['summary', 'window'],
	shared: ['summary', 'window'],
	router: ['summary', 'window', 'explicit', 'tracked']
};

function ownershipReason(refusal: OwnershipRefusal): RouterReason {
	switch (refusal.reason) {
		case 'no-window':
			return 'no-certificate';
		case 'allocator':
		case 'ptr-store':
		case 'ptr-return':
		case 'ptr-import':
		case 'ptr-compare':
		case 'ptr-control':
		case 'ptr-deref':
			return 'allocator-state';
		case 'read-before-write':
		case 'aliasing':
		case 'final-state':
			return 'shared-state';
		default:
			return 'unclassified-dependency';
	}
}

/** The prefix domain is tried after a plain refusal unless the caller chose an option the checker does not combine with it. @internal */
export function effectiveOwnership(given: OwnershipOptions | undefined): {
	options: OwnershipOptions | null;
	prefixFallback: boolean;
} {
	const o = given ?? {};
	const prefixFallback =
		o.prefix === undefined && !o.allocator && !o.config && (o.recursion ?? 1) <= 1;
	return {
		options: prefixFallback ? { ...o, prefix: true } : (given ?? null),
		prefixFallback
	};
}

/** Everything `decide` needs and makes: the choice, the certificate the route runs on, and the trace. */
interface Plan {
	decision: RouterDecision;
	stream?: StreamCertificate;
	window?: OwnershipCertificate;
}

/**
 * Chooses the route from the module bytes and the call, without running the call. The order is the
 * certified summary, then the certified window, then the explicit route when the caller supplied
 * one, then the tracked route when its assumptions hold, else serial. Both certifiers are asked
 * only for the call shape they can serve, and a refusal is cached like a certificate.
 * @since 1.1.0
 */
export function decide(bytes: Uint8Array, call: RouterCall, options: RouterOptions): Plan {
	const cache = options.cache ?? new CertificateCache();
	const workers = options.workers ?? Math.max(1, Math.min(availableParallelism(), 8));
	const allowed = MODE_ROUTES[options.mode];
	const considered: Consideration[] = [];
	const analyses: RouterDecision['analyses'] = [];
	let certifyMs = 0;
	let anyMiss = false;
	const note = (
		route: Route,
		verdict: Consideration['verdict'],
		reason: RouterReason,
		detail = ''
	) => considered.push({ route, verdict, reason, detail });
	const finish = (
		route: Route,
		reason: RouterReason,
		detail: string,
		extra: Partial<Plan> = {}
	): Plan => {
		note(route, route === 'serial' ? 'refused' : 'taken', reason, detail);
		return {
			decision: {
				route,
				reason,
				detail,
				mode: options.mode,
				certifyMs,
				cacheHit: analyses.length > 0 && !anyMiss,
				analyses,
				considered
			},
			...extra
		};
	};
	const ask = <S extends Slot>(slot: S, config: unknown, make: () => NonNullable<Entry[S]>) => {
		const answer = cache.get(bytes, config, slot, make);
		analyses.push(slot);
		certifyMs += answer.ms;
		if (!answer.hit) anyMiss = true;
		return answer.value;
	};
	const config = (extra: unknown) => ({ entry: call.entry, extra });

	if (options.mode === 'serial') return finish('serial', 'mode-serial', 'the mode is serial');
	if (workers < 2)
		return finish('serial', 'single-worker', 'one worker leaves nothing to run beside');

	if (call.kind === 'stream') {
		if (!allowed.includes('summary'))
			return finish('serial', 'no-route-in-mode', 'the mode has no route for a stream call');
		if (options.mode === 'shared') {
			const shape = ask('shape', config('shape'), () => analyzeModule(bytes, call.entry));
			if (!streamShaped(shape))
				return finish('serial', 'not-a-stream', 'the entry is not state, pointer, length');
		}
		const result = ask('stream', config('stream'), () => certifyStream(bytes, call.entry));
		if (result.kind !== 'certificate') return finish('serial', 'stream-refused', result.reason);
		return finish('summary', 'certified-summary', `${result.ring} over ${result.bits} bits`, {
			stream: result
		});
	}

	if (allowed.includes('summary'))
		note('summary', 'skipped', 'not-a-stream', 'the call is a loop of records');
	if (options.mode === 'shared') {
		const shape = ask('shape', config('shape'), () => analyzeModule(bytes, call.entry));
		if (!recordsShaped(shape))
			return finish(
				'serial',
				'no-certificate',
				'the entry does not take a table, a count and an output'
			);
		if (!shape.memoryImported)
			return finish('serial', 'memory-not-imported', 'the module defines its memory');
	}
	if (
		!allowed.includes('window') &&
		!allowed.includes('tracked') &&
		!allowed.includes('explicit')
	)
		return finish('serial', 'no-route-in-mode', 'the mode has no route for a records call');

	const ownership = effectiveOwnership(options.ownership);
	const result = ask('ownership', config(['ownership', ownership.options]), () => {
		const plain = certifyOwnership(bytes, { entry: call.entry, ...options.ownership });
		if (plain.kind === 'certificate' || !ownership.prefixFallback) return plain;
		// the prefix option is not a superset of the plain check, so it runs second and a refusal keeps the plain reason
		const prefixed = certifyOwnership(bytes, {
			entry: call.entry,
			...options.ownership,
			prefix: true
		});
		return prefixed.kind === 'certificate' ? prefixed : plain;
	});
	let refusal: OwnershipRefusal | undefined;
	if (result.kind === 'certificate') {
		if (!allowed.includes('window')) {
			note('window', 'skipped', 'no-route-in-mode', 'the mode excludes the window route');
		} else if (result.wildStores > 0)
			note(
				'window',
				'refused',
				'wild-store',
				`${result.wildStores} stores write an address no record owns`
			);
		else if (!guardRecords(result, [...call.regions, ...call.writes]))
			note(
				'window',
				'refused',
				'layout-overlap',
				'a record region overlaps a certified window'
			);
		else
			return finish('window', 'certified-window', `${result.windows.length} windows`, {
				window: result
			});
	} else {
		refusal = result;
		note('window', 'refused', ownershipReason(result), `${result.reason}: ${result.detail}`);
	}
	if (allowed.includes('explicit') && options.explicit)
		return finish('explicit', 'explicit-runner', 'the caller supplied a runner');
	if (!allowed.includes('tracked')) {
		const last = considered[considered.length - 1]!;
		const reason: RouterReason = last.verdict === 'refused' ? last.reason : 'no-certificate';
		return finish('serial', reason, last.detail);
	}
	// the tracked route runs only where the certifier found no shared state to protect
	if (!refusal) {
		const last = considered[considered.length - 1]!;
		return finish('serial', last.reason, last.detail);
	}
	// allocator statics move to a slot-private window the route validates, and the loss rule ends a dispatch that does not pay
	const why = ownershipReason(refusal);
	if (why !== 'no-certificate' && why !== 'allocator-state')
		return finish('serial', why, `${refusal.reason}: ${refusal.detail}`);
	const { importsDeterministic, residueUnobserved } = options.assume ?? {};
	const shape = ask('shape', config('shape'), () => analyzeModule(bytes, call.entry));
	if (!(importsDeterministic || shape.functionImports === 0) || !residueUnobserved)
		return finish(
			'serial',
			'assumption-unasserted',
			'the tracked route needs deterministic imports and unobserved stack residue'
		);
	return finish(
		'tracked',
		'tracked-eligible',
		'no shared window; the caller asserts the tracked assumptions'
	);
}

/**
 * The open route behind one call description: it holds the memory, the pools and the sticky
 * admission decision. Write the inputs into `memory` after `open`, then `run`.
 * @since 1.1.0
 */
export class Router {
	readonly decision: RouterDecision;
	/** Wall time of `open` after the decision: memory, instances and pools. */
	readonly setupMs: number;
	readonly #call: RouterCall;
	readonly #options: RouterOptions;
	readonly #memory: WebAssembly.Memory;
	readonly #owner: (...args: (number | bigint)[]) => unknown;
	#route: Route;
	#window?: OwnershipSlices;
	#folio?: Folio;
	#stream?: {
		certificate: StreamCertificate;
		pool: TaskPool;
		workers: Worker[];
		module: WebAssembly.Module;
	};
	// serial time of one record from the first probe, kept so the floor test needs no second probe
	#perRecordMs?: number;
	#dispatches = 0;
	#losses = 0;
	#why?: RouterReason;
	#exports: WebAssembly.Exports = {};
	// width of the stream state in bits, for the serial path of a stream call
	#bits = 32;
	#closed = false;

	private constructor(
		decision: RouterDecision,
		call: RouterCall,
		options: RouterOptions,
		memory: WebAssembly.Memory,
		owner: (...args: (number | bigint)[]) => unknown,
		route: Route,
		setupMs: number
	) {
		this.decision = decision;
		this.#call = call;
		this.#options = options;
		this.#memory = memory;
		this.#owner = owner;
		this.#route = route;
		this.setupMs = setupMs;
	}

	get memory(): WebAssembly.Memory {
		return this.#memory;
	}

	/** The route the next call takes: the decision's, or serial once a floor test refused it. */
	get route(): Route {
		return this.#route;
	}

	static async open(
		bytes: Uint8Array,
		call: RouterCall,
		options: RouterOptions
	): Promise<Router> {
		const plan = decide(bytes, call, options);
		const started = performance.now();
		const workers = options.workers ?? Math.max(1, Math.min(availableParallelism(), 8));
		const extra = options.imports
			? ((await import(String(options.imports))).default() as WebAssembly.Imports)
			: {};
		let decision = plan.decision;
		const refuse = (reason: RouterReason, detail: string) => {
			decision = { ...decision, route: 'serial', reason, detail };
			decision.considered = [
				...decision.considered,
				{ route: plan.decision.route, verdict: 'refused', reason, detail }
			];
		};
		const serialOwner = (module: Uint8Array, memory?: WebAssembly.Memory) => {
			const compiled = new WebAssembly.Module(Uint8Array.from(module));
			const wantsMemory = WebAssembly.Module.imports(compiled).find(
				(i) => i.kind === 'memory'
			);
			// a program that imports its memory shared links only to a shared one
			const sharedImport =
				!!wantsMemory &&
				(() => {
					try {
						return Buffer.compare(sharedMemoryImport(module), module) === 0;
					} catch {
						return false;
					}
				})();
			const own =
				memory ??
				new WebAssembly.Memory({
					initial: options.pages,
					maximum: options.pages,
					...(sharedImport ? { shared: true } : {})
				});
			const imports: WebAssembly.Imports = {
				...extra,
				...(wantsMemory
					? {
							[wantsMemory.module]: {
								...(extra[wantsMemory.module] ?? {}),
								[wantsMemory.name]: own
							}
						}
					: {})
			};
			const exports = new WebAssembly.Instance(compiled, imports).exports;
			const exported = exports.memory as WebAssembly.Memory | undefined;
			return {
				memory: wantsMemory ? own : (exported ?? own),
				fn: exports[call.entry] as (...a: (number | bigint)[]) => unknown,
				exports
			};
		};

		if (decision.route === 'summary') {
			const certificate = plan.stream!;
			const subject = shareCertified(bytes, certificate, options.pages);
			const memory = new WebAssembly.Memory({
				initial: options.pages,
				maximum: options.pages,
				shared: true
			});
			installPrefill(subject, memory);
			const module = new WebAssembly.Module(subject.bytes);
			const pool = new TaskPool(workers);
			const threads = Array.from({ length: workers }, (_, index) => {
				const link = pool.link(index);
				return new Worker(workerUrl(), {
					workerData: { module, memory, link, layout: certificate.layout },
					transferList: [link.port]
				});
			});
			const exports = new WebAssembly.Instance(module, { env: { memory } }).exports;
			const fn = exports[call.entry] as (...a: (number | bigint)[]) => unknown;
			const router = new Router(decision, call, options, memory, fn, 'summary', 0);
			router.#exports = exports;
			router.#stream = { certificate, pool, workers: threads, module };
			router.#bits = certificate.bits;
			return router.#timed(started);
		}

		if (decision.route === 'serial') {
			const { memory, fn, exports } = serialOwner(bytes);
			const router = new Router(decision, call, options, memory, fn, 'serial', 0);
			router.#exports = exports;
			if (call.kind === 'stream')
				router.#bits = analyzeModule(bytes, call.entry).entryParams[0] === 'i64' ? 64 : 32;
			return router.#timed(started);
		}

		// a parallel route over a records call needs a shared memory the module imports
		let shared: Uint8Array<ArrayBuffer>;
		try {
			shared = sharedMemoryImport(bytes);
		} catch (error) {
			refuse('memory-not-imported', (error as Error).message);
			const { memory, fn, exports } = serialOwner(bytes);
			const router = new Router(decision, call, options, memory, fn, 'serial', 0);
			router.#exports = exports;
			return router.#timed(started);
		}
		const memory = new WebAssembly.Memory({
			initial: options.pages,
			maximum: options.maxPages ?? 65536,
			shared: true
		});
		const route = decision.route;
		const { fn, exports } = serialOwner(shared, memory);
		const router = new Router(decision, call, options, memory, fn, route, 0);
		router.#exports = exports;
		try {
			if (route === 'window')
				router.#window = await OwnershipSlices.open(bytes, plan.window!, {
					memory,
					workers,
					imports: options.imports
				});
			else if (route === 'tracked')
				router.#folio = await Folio.open(bytes, {
					memory,
					workers,
					imports: Object.keys(extra).length ? extra : undefined
				});
		} catch (error) {
			if (route !== 'tracked') throw error;
			router.#route = 'serial';
			const detail = String((error as Error).message).slice(0, 200);
			router.decision.route = 'serial';
			router.decision.reason = 'tracked-ineligible';
			router.decision.detail = detail;
			router.decision.considered.push({
				route: 'tracked',
				verdict: 'refused',
				reason: 'tracked-ineligible',
				detail
			});
		}
		return router.#timed(started);
	}

	/** Calls another export of the module on the owner thread, for setup that is not part of the loop. */
	exec(name: string, args: (number | bigint)[] = []): unknown {
		const fn = this.#exports[name];
		if (typeof fn !== 'function') throw new TypeError(`the module exports no function ${name}`);
		return fn(...args);
	}

	#timed(started: number): Router {
		(this as { setupMs: number }).setupMs = performance.now() - started;
		return this;
	}

	/** Runs the call. A records call probes record 0 once and then follows the floor test. */
	async run(options: { initial?: bigint } = {}): Promise<RouterRun> {
		const call = this.#call;
		const started = performance.now();
		const done = (
			route: Route,
			reason: RouterReason,
			extra: Partial<RouterRun> = {}
		): RouterRun => ({
			route,
			reason,
			wallMs: performance.now() - started,
			...extra
		});
		if (call.kind === 'stream') {
			const input = new Uint8Array(this.#memory.buffer, call.ptr, call.len);
			const floor = this.#options.floors?.summaryMinBytes ?? routerConstants.summaryMinBytes;
			if (this.#stream && call.len >= floor) {
				const { certificate, pool } = this.#stream;
				const fold = certificate.output ? reconstructCertified : foldCertified;
				const result = fold(pool, input, this.#memory, certificate, {
					initial: options.initial
				});
				return done('summary', 'certified-summary', { state: result.state });
			}
			const layout = this.#stream?.certificate.layout ?? { state: 0, ptr: 1, len: 2 };
			const args: (number | bigint)[] = [0, 0, 0];
			const initial = options.initial ?? 0n;
			args[layout.state] =
				this.#bits === 32 ? Number(BigInt.asIntN(32, initial)) : BigInt.asIntN(64, initial);
			args[layout.ptr] = call.ptr;
			args[layout.len] = call.len;
			const end = this.#owner(...args);
			return done('serial', this.#stream ? 'below-floor' : this.decision.reason, {
				state: BigInt.asUintN(this.#bits, BigInt(end as number | bigint))
			});
		}
		if (this.#route === 'serial') {
			this.#owner(...call.args(0, call.count));
			return done(
				'serial',
				this.decision.route === 'serial'
					? this.decision.reason
					: (this.#why ?? 'below-floor')
			);
		}
		let probeMs: number | undefined;
		if (this.#perRecordMs === undefined) {
			if (call.count < 2) {
				this.#owner(...call.args(0, call.count));
				return done('serial', 'below-floor');
			}
			// the first record pays the compile and the cold caches, so a probe of several takes the least of the rest
			const probed = Math.max(1, Math.min(PROBE_RECORDS, call.count >> 2));
			const times: number[] = [];
			for (let i = 0; i < probed; i++) {
				const t = performance.now();
				this.#owner(...call.args(i, i + 1));
				times.push(performance.now() - t);
			}
			probeMs = times.reduce((sum, ms) => sum + ms, 0);
			this.#perRecordMs = Math.min(...(probed > 1 ? times.slice(1) : times));
			return this.#after(call, probed, probeMs, started);
		}
		return this.#after(call, 0, undefined, started);
	}

	// two dispatches in a row past the first that cost more than the serial time of their records end the dispatch
	#judge(ms: number, left: number): void {
		this.#dispatches++;
		if (this.#dispatches < 2) return;
		if (ms * iterationAdmissionConstants.margin <= left * this.#perRecordMs!) this.#losses = 0;
		else if (++this.#losses >= 2) {
			this.#route = 'serial';
			this.#why = 'dispatch-lost';
		}
	}

	async #after(
		call: RecordsCall,
		from: number,
		probeMs: number | undefined,
		started: number
	): Promise<RouterRun> {
		const done = (
			route: Route,
			reason: RouterReason,
			extra: Partial<RouterRun> = {}
		): RouterRun => ({
			route,
			reason,
			wallMs: performance.now() - started,
			probeMs,
			...extra
		});
		const left = call.count - from;
		const floors = { ...routerConstants, ...this.#options.floors };
		const floor = this.#route === 'window' ? floors.windowFloorMs : floors.trackedFloorMs;
		if (left < 2 || left * this.#perRecordMs! <= floor) {
			const t = performance.now();
			if (left > 0) this.#owner(...call.args(from, call.count));
			// a serial run is the best estimate of the serial time; the estimate only goes down
			if (from === 0 && left > 0)
				this.#perRecordMs = Math.min(this.#perRecordMs!, (performance.now() - t) / left);
			return done('serial', 'below-floor');
		}
		const dispatched = performance.now();
		if (this.#route === 'window') {
			await this.#window!.run(left, (a, b) => call.args(a + from, b + from), {
				regions: call.regions,
				writes: call.writes
			});
			this.#judge(performance.now() - dispatched, left);
			return done('window', 'certified-window');
		}
		if (this.#route === 'tracked') {
			const rest = call.args(from, call.count);
			const report = await this.#folio!.run(call.entry, rest);
			// a loop the iteration route did not dispatch pays its lowered owner on every call: stop asking
			if (!report.iteration?.batches) {
				this.#route = 'serial';
				this.#why = 'below-floor';
			} else {
				this.#perRecordMs = lowerEstimate(
					this.#perRecordMs!,
					report.iteration.admission?.plainIterationMs
				);
				this.#judge(performance.now() - dispatched, left);
			}
			return done('tracked', 'tracked-eligible', {
				tracked: { mode: report.mode, reason: report.reason, iteration: report.iteration }
			});
		}
		await this.#options.explicit!(
			from ? { ...call, count: left, args: (a, b) => call.args(a + from, b + from) } : call
		);
		this.#judge(performance.now() - dispatched, left);
		return done('explicit', 'explicit-runner');
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#window?.close();
		await this.#folio?.close();
		if (this.#stream) {
			this.#stream.pool.close();
			await Promise.all(this.#stream.workers.map((w) => w.terminate()));
		}
	}
}

const workerUrl = () =>
	new URL(`./router-worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url);

export const openRouter = Router.open;
