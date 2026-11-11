import type { Checkpoint, Program, Stats } from './engine.ts';
import { Pager, Resident, runSegment } from './engine.ts';
import type { Codec } from './lz4.ts';
import type { Expected, Workload } from './programs.ts';
import { PAGE, basePage, chaseIterations, entryOf, expectedOf, expectedPage } from './programs.ts';
import { NoStore, type Backend } from './store.ts';

// what a request names; quantum null is one request for the whole program
export interface RunConfig {
	workload: Workload;
	pages: number;
	frames: number;
	cold: number;
	rowBytes: number;
	quantum: number | null;
	randomSeed?: number;
	evictEvery?: boolean;
	resident?: boolean;
	ephemeral?: boolean;
}

export interface ObjectDeps {
	makeBackend(rowBytes: number): Backend;
	codec?: () => Codec;
	dense: WebAssembly.Module;
	trace: WebAssembly.Module;
	clock: () => number;
	// the page an untouched workload starts from; a test swaps in a memoised copy
	makePage?: (page: number, out: Uint8Array) => void;
	// byte equality of two pages; a native compare when the host has one
	equal?: (a: Uint8Array, b: Uint8Array) => boolean;
}

const wordsEqual = (a: Uint8Array, b: Uint8Array) => {
	const x = new Uint32Array(a.buffer, a.byteOffset, a.length / 4);
	const y = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
	for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
	return true;
};

const memo = new Map<string, Expected>();
function expectedFor(workload: Workload, pages: number) {
	const key = `${workload}:${pages}`;
	let value = memo.get(key);
	if (!value) memo.set(key, (value = expectedOf(workload, pages)));
	return value;
}

const json = (body: object, status = 200) => Response.json(body, { status });

interface Session {
	epoch: string;
	pager: Pager | Resident;
	expected: Expected;
	program: Program;
	cfg: RunConfig;
}

// one Durable Object's worth of state; the class in worker.ts holds one of these
export class ExecutorObject {
	private backend?: Backend;
	private session?: Session;
	private readonly epochs: string;
	private readonly deps: ObjectDeps;

	constructor(deps: ObjectDeps) {
		this.deps = deps;
		this.epochs = crypto.randomUUID();
	}

	private backendFor(cfg: RunConfig) {
		return (this.backend ??= cfg.resident
			? new NoStore()
			: this.deps.makeBackend(cfg.rowBytes));
	}

	private programOf(cfg: RunConfig, expected: Expected): Program {
		if (cfg.workload === 'dense')
			return { module: this.deps.dense, entry: 'run', args: [cfg.pages], fuel: 100000000 };
		const entry = entryOf(cfg.workload);
		if (cfg.workload === 'chase')
			return {
				module: this.deps.trace,
				entry,
				args: [chaseIterations(cfg.pages), cfg.pages]
			};
		return {
			module: this.deps.trace,
			entry,
			args: [expected.ops.length],
			extra: { op: (i: number) => expected.ops[i]! }
		};
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const op = url.pathname.slice(1);
		try {
			if (op === 'ping') return json({ ok: 1, epoch: this.epochs });
			const cfg = JSON.parse(url.searchParams.get('cfg') ?? 'null') as RunConfig;
			if (!cfg) throw new Error('missing cfg');
			if (cfg.resident && cfg.workload !== 'dense')
				throw new Error('a resident variant runs the dense chain only');
			const began = this.deps.clock();
			const backend = this.backendFor(cfg);
			const before = { written: backend.rowsWritten, read: backend.rowsRead };
			const rows = () => ({
				rowsWritten: backend.rowsWritten - before.written,
				rowsRead: backend.rowsRead - before.read,
				inMs: this.deps.clock() - began
			});
			if (op === 'init') return json(this.init(cfg, backend, rows));
			if (op === 'run') return await this.run(cfg, request, rows);
			if (op === 'verify') {
				const pager = this.session?.pager;
				// an ephemeral run's resident dirty frames are its only copy of those pages
				const read =
					pager instanceof Resident
						? (page: number) => pager.page(page)
						: cfg.ephemeral && pager
							? (page: number) => pager.dirtyFrame(page) ?? backend.read(page)
							: (page: number) => backend.read(page);
				return json(this.verify(cfg, read, rows));
			}
			if (op === 'clear') {
				this.session = undefined;
				return json({ cleared: true, rows: backend.clear(), ...rows() });
			}
			return json({ error: `unknown op ${op}` }, 404);
		} catch (error) {
			return json({ error: String(error) }, 500);
		}
	}

	private init(cfg: RunConfig, backend: Backend, rows: () => object) {
		const setupRows = backend.setup();
		const make = this.deps.makePage ?? basePage;
		const written = backend.rowsWritten;
		if (cfg.workload !== 'dense') {
			const bytes = new Uint8Array(PAGE);
			for (let page = 0; page < cfg.pages; page++) {
				make(page, bytes);
				backend.write(page, bytes);
			}
		}
		return { setupRows, rows: backend.rowsWritten - written, ...rows() };
	}

	private async run(cfg: RunConfig, request: Request, rows: () => object) {
		const epoch = request.headers.get('x-epoch');
		const body = new Uint8Array(await request.arrayBuffer());
		let resume: Checkpoint | undefined;
		if (epoch) {
			if (this.session?.epoch !== epoch)
				return json({ error: 'executor restarted, frames lost', epoch: this.epochs }, 409);
			resume = {
				memory: body,
				completion: Number(request.headers.get('x-completion') ?? '0')
			};
		} else {
			const expected = expectedFor(cfg.workload, cfg.pages);
			this.session = {
				epoch: crypto.randomUUID(),
				pager: cfg.resident
					? new Resident(cfg.pages)
					: new Pager({
							frames: cfg.frames,
							cold: cfg.cold,
							pages: cfg.pages,
							backend: this.backendFor(cfg),
							codec: cfg.cold > 0 ? this.deps.codec!() : undefined,
							clock: this.deps.clock,
							randomSeed: cfg.randomSeed,
							evictEvery: cfg.evictEvery,
							ephemeral: cfg.ephemeral
						}),
				expected,
				program: this.programOf(cfg, expected),
				cfg
			};
		}
		const s = this.session!;
		const { pager } = s;
		const segment = await runSegment(
			s.program,
			(kind, at, value, width) => pager.handle(kind, at, value, width),
			cfg.quantum ?? Infinity,
			resume
		);
		if (!segment.done)
			return new Response(segment.checkpoint.memory, {
				headers: {
					'x-done': '0',
					'x-epoch': s.epoch,
					'x-completion': String(segment.checkpoint.completion),
					'x-meta': JSON.stringify({ ops: segment.ops, ...rows() })
				}
			});
		pager.flush();
		const stats: Stats = { ...pager.stats };
		return json({
			done: true,
			result: segment.result,
			exact: segment.result === s.expected.checksum,
			expected: s.expected.checksum,
			stats,
			frames: pager.residentFrames,
			pooled: pager.pooledPages,
			...rows()
		});
	}

	private verify(
		cfg: RunConfig,
		read: (page: number) => Uint8Array | null | Promise<Uint8Array | null>,
		rows: () => object
	) {
		const expected = expectedFor(cfg.workload, cfg.pages);
		const want = new Uint8Array(PAGE);
		const equal = this.deps.equal ?? wordsEqual;
		let mismatches = 0;
		let first = -1;
		for (let page = 0; page < cfg.pages; page++) {
			const got = read(page);
			if (got instanceof Promise) throw new Error('async backend');
			expectedPage(cfg.workload, page, cfg.pages, expected, want, this.deps.makePage);
			if (!got || !equal(got, want)) {
				mismatches++;
				if (first < 0) first = page;
			}
		}
		return {
			exact: mismatches === 0,
			pages: cfg.pages,
			bytes: cfg.pages * PAGE,
			mismatches,
			first,
			...rows()
		};
	}
}

export interface Routable {
	fetch(request: Request): Promise<Response>;
}

// the front Worker: bearer check, then /obj/NAME/OP goes to that object; the colo rides back in a header
export async function route(
	request: Request,
	objects: (name: string) => Routable,
	secret: string,
	colo: string | null
): Promise<Response> {
	if (request.headers.get('authorization') !== `Bearer ${secret}`)
		return new Response('unauthorized', { status: 401 });
	const url = new URL(request.url);
	if (url.pathname === '/ready') return json({ ready: true });
	const [, kind, name, op] = url.pathname.split('/');
	if (kind !== 'obj' || !name || !op) return new Response('not found', { status: 404 });
	const headers = new Headers();
	for (const key of ['x-epoch', 'x-completion']) {
		const value = request.headers.get(key);
		if (value) headers.set(key, value);
	}
	const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;
	const response = await objects(name).fetch(
		new Request(`https://do/${op}${url.search}`, { method: 'POST', body, headers })
	);
	const out = new Response(response.body, response);
	out.headers.set('x-front-colo', colo ?? '');
	return out;
}
