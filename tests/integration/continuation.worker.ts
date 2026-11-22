import guestModule from '../../build/continuation.wasm';
import { cpuSignal, runSlice, type DurableObjectStorage } from '../../src/continuation.ts';

interface Env {
	CONT: {
		idFromName(name: string): unknown;
		get(id: unknown): { fetch(request: Request): Promise<Response> };
	};
}

interface Ctx {
	storage: DurableObjectStorage;
	abort(reason?: string): void;
}

interface Config {
	every: number;
	abort: number[];
}

interface Guest {
	memory: WebAssembly.Memory;
	run(budget: number): number;
	get_steps(): number;
}

const hex = (buffer: ArrayBuffer) =>
	Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

// one object instance per run name; `instance` changes each time the object restarts
export class Continuation {
	readonly instance = crypto.randomUUID();
	private readonly ctx: Ctx;
	private readonly env: Env;
	private guest?: WebAssembly.Instance;

	constructor(ctx: Ctx, env: Env) {
		this.ctx = ctx;
		this.env = env;
		this.query('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
		this.query(
			'CREATE TABLE IF NOT EXISTS trace (slice INTEGER PRIMARY KEY, instance TEXT NOT NULL, restored INTEGER NOT NULL, stop TEXT NOT NULL, epoch INTEGER NOT NULL, steps INTEGER NOT NULL)'
		);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/start') {
			const every = Number(url.searchParams.get('every') ?? '10000');
			const abort = (url.searchParams.get('abort') ?? '')
				.split(',')
				.filter(Boolean)
				.map(Number);
			this.put('config', JSON.stringify({ every, abort } satisfies Config));
			await this.ctx.storage.setAlarm(Date.now());
			return new Response('started', { status: 202 });
		}
		if (url.pathname === '/status') {
			const trace = this.query(
				'SELECT slice, instance, restored, stop, epoch, steps FROM trace ORDER BY slice'
			).map((row) => ({
				slice: Number(row.slice),
				instance: String(row.instance),
				restored: Number(row.restored) === 1,
				stop: String(row.stop),
				epoch: Number(row.epoch),
				steps: Number(row.steps)
			}));
			const final = this.get('final');
			return Response.json({ trace, final: final ? JSON.parse(final) : null });
		}
		return new Response('not found', { status: 404 });
	}

	async alarm(): Promise<void> {
		const config = JSON.parse(this.get('config') ?? 'null') as Config;
		this.guest ??= new WebAssembly.Instance(guestModule, {});
		const guest = this.guest.exports as unknown as Guest;
		const memory = guest.memory;
		const every = config.every;

		const result = await runSlice({
			storage: this.ctx.storage,
			memory,
			signal: cpuSignal(this.guest, memory),
			// local workerd never raises the signal, so the guest stops itself every `every` steps
			run: (budget) => (guest.run(Math.min(budget, every)) ? 'finished' : 'budget'),
			steps: () => guest.get_steps(),
			initialBudget: every
		});

		const slice = Number(this.query('SELECT COUNT(*) AS n FROM trace')[0]?.n ?? 0) + 1;
		this.query(
			'INSERT INTO trace (slice, instance, restored, stop, epoch, steps) VALUES (?, ?, ?, ?, ?, ?)',
			slice,
			this.instance,
			result.restored ? 1 : 0,
			result.stop,
			result.epoch,
			guest.get_steps()
		);

		if (result.finished) {
			const sha = hex(await crypto.subtle.digest('SHA-256', memory.buffer));
			this.put(
				'final',
				JSON.stringify({ steps: guest.get_steps(), sha, bytes: memory.buffer.byteLength })
			);
			return;
		}
		if (config.abort.includes(slice)) {
			await this.ctx.storage.sync();
			this.ctx.abort('forced');
		}
	}

	private query(text: string, ...bindings: (string | number)[]): Record<string, unknown>[] {
		return this.ctx.storage.sql.exec(text, ...bindings).toArray();
	}

	private put(key: string, value: string): void {
		this.query('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', key, value);
	}

	private get(key: string): string | undefined {
		const row = this.query('SELECT v FROM kv WHERE k = ?', key)[0];
		return row ? String(row.v) : undefined;
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const run = new URL(request.url).searchParams.get('run') ?? 'chain';
		return env.CONT.get(env.CONT.idFromName(run)).fetch(request);
	}
};
