import { DurableObject } from 'cloudflare:workers';
import type { LaneCoordinator, LaneHold, TaskRegistry } from '../../src/managed/pool.ts';
import { LanePool, serveLane } from '../../src/managed/pool.ts';
import type { TaskValue } from '../../src/managed/tasks.ts';
import { chunk, LEASE_MS, taskId } from './task.ts';

interface Env {
	PROBE_TOKEN: string;
	COORD: DurableObjectNamespace<PoolCoordinator>;
	LANES: DurableObjectNamespace<PoolLane>;
}

type Injection = 'burn' | 'sleep' | 'abort';

interface UnitArgs {
	index: number;
	passes: number;
	// set on the one unit that carries a fault, which fires on its first attempt only
	fault?: Injection;
	burn?: number;
}

interface Config {
	name: string;
	run: string;
	width: number;
	batch: number;
}

// objects of one class may share an isolate, so the ready probe reports it
let isolateId: string | undefined;
const isolate = () => (isolateId ??= crypto.randomUUID());

const unitArgs = (value: TaskValue) => JSON.parse(String(value)) as UnitArgs;

export class PoolCoordinator extends DurableObject<Env> {
	#active?: LanePool;
	#laneErrors: { lane: number; message: string }[] = [];

	constructor(ctx: DurableObject<Env>['ctx'], env: Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec('CREATE TABLE IF NOT EXISTS lane_config (k INTEGER PRIMARY KEY, v TEXT NOT NULL)');
		sql.exec(
			'CREATE TABLE IF NOT EXISTS lane_outcomes (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, attempt INTEGER NOT NULL, outcome TEXT NOT NULL)'
		);
	}

	// the pool is rebuilt from the stored config, so any call works after the object restarts
	#pool(): LanePool {
		if (this.#active) return this.#active;
		const row = this.ctx.storage.sql.exec('SELECT v FROM lane_config WHERE k = 1').toArray()[0];
		if (!row) throw new Error('no run in progress');
		return (this.#active = this.#build(JSON.parse(String(row.v)) as Config));
	}

	#build(config: Config): LanePool {
		return new LanePool(this.ctx.storage.sql, {
			width: config.width,
			leaseMs: LEASE_MS,
			claimBatch: config.batch,
			flush: () => this.ctx.storage.sync(),
			transport: {
				work: async (lane) => {
					try {
						await this.env.LANES.get(
							this.env.LANES.idFromName(`${config.run}-lane-${lane}`)
						).work(config.name);
					} catch (error) {
						this.#laneErrors.push({
							lane,
							message: String((error as Error)?.message ?? error).slice(0, 300)
						});
						throw error;
					}
				}
			}
		});
	}

	claim() {
		return this.#pool().claim();
	}

	async complete(id: string, attempt: number, result: TaskValue) {
		const outcome = await this.#pool().complete(id, attempt, result);
		this.ctx.storage.sql.exec(
			'INSERT INTO lane_outcomes (id, attempt, outcome) VALUES (?, ?, ?)',
			id,
			attempt,
			outcome
		);
		await this.ctx.storage.sync();
		return outcome;
	}

	fail(id: string, attempt: number, error: string) {
		return this.#pool().fail(id, attempt, error);
	}

	renew(holds: readonly LaneHold[]) {
		return this.#pool().renew(holds);
	}

	// the serial arm: the same units, in this object, one after another
	serial(units: number, passes: number) {
		return { outputs: Array.from({ length: units }, (_, index) => chunk(index, passes)) };
	}

	async pool(
		config: Config,
		units: number,
		passes: number,
		fault?: UnitArgs & { index: number }
	) {
		this.ctx.storage.sql.exec(
			'INSERT OR REPLACE INTO lane_config (k, v) VALUES (1, ?)',
			JSON.stringify(config)
		);
		this.#laneErrors = [];
		const pool = (this.#active = this.#build(config));
		await pool.submit(
			Array.from({ length: units }, (_, index) => ({
				id: taskId(index),
				name: 'chunk',
				argsJson: fault && fault.index === index ? fault : { index, passes }
			}))
		);
		const report = await pool.run();
		const outputs = pool.fold((all: string[], result) => (all.push(result.text()), all), []);
		return { outputs, report, laneErrors: this.#laneErrors };
	}

	// claims and accepted completions per task, read after the lanes have had time to return
	state() {
		const sql = this.ctx.storage.sql;
		const attempts: Record<string, number> = {};
		for (const row of sql.exec('SELECT id, attempt FROM folio_tasks').toArray())
			attempts[String(row.id)] = Number(row.attempt);
		const accepted: Record<string, number> = {};
		const outcomes: { id: string; attempt: number; outcome: string }[] = [];
		for (const row of sql
			.exec('SELECT id, attempt, outcome FROM lane_outcomes ORDER BY n')
			.toArray()) {
			outcomes.push({
				id: String(row.id),
				attempt: Number(row.attempt),
				outcome: String(row.outcome)
			});
			if (row.outcome !== 'ignored')
				accepted[String(row.id)] = (accepted[String(row.id)] ?? 0) + 1;
		}
		return { attempts, accepted, outcomes };
	}
}

export class PoolLane extends DurableObject<Env> {
	#silent = false;

	ping() {
		return { object: this.ctx.id.toString(), isolate: isolate() };
	}

	work(coordinatorName: string) {
		const stub = this.env.COORD.get(this.env.COORD.idFromName(coordinatorName));
		const coordinator: LaneCoordinator = {
			claim: () => stub.claim(),
			complete: (id, attempt, result) => stub.complete(id, attempt, result),
			fail: (id, attempt, error) => stub.fail(id, attempt, error),
			// a silent lane reports its leases as renewed and renews none
			renew: async (holds) => (this.#silent ? holds.map(() => true) : stub.renew(holds))
		};
		return serveLane(this.#registry()).work(coordinator);
	}

	#registry(): TaskRegistry {
		return {
			chunk: (args, task) => {
				const unit = unitArgs(args);
				if (unit.fault && task.attempt === 1) return this.#inject(unit);
				return chunk(unit.index, unit.passes);
			}
		};
	}

	async #inject(unit: UnitArgs): Promise<string> {
		if (unit.fault === 'abort') this.ctx.abort('injected reset');
		// runs past the worker's cpu limit, so the platform ends this invocation
		if (unit.fault === 'burn') chunk(unit.index, unit.burn ?? unit.passes);
		if (unit.fault === 'sleep') {
			this.#silent = true;
			await new Promise((resolve) => setTimeout(resolve, LEASE_MS * 1.6));
			this.#silent = false;
		}
		return chunk(unit.index, unit.passes);
	}
}

const number = (url: URL, key: string) => Number(url.searchParams.get(key));

export default {
	async fetch(request: Request, env: Env) {
		if (request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url);
		const name = url.searchParams.get('name') ?? 'local';
		const run = url.searchParams.get('run') ?? 'local';
		const coordinator = () => env.COORD.get(env.COORD.idFromName(name));
		if (url.pathname === '/ready') {
			const width = number(url, 'k');
			const lanes = await Promise.all(
				Array.from({ length: width }, (_, lane) =>
					env.LANES.get(env.LANES.idFromName(`${run}-lane-${lane}`)).ping()
				)
			);
			return Response.json({ lanes });
		}
		if (url.pathname === '/serial')
			return Response.json(
				await coordinator().serial(number(url, 'n'), number(url, 'passes'))
			);
		if (url.pathname === '/pool') {
			const kind = url.searchParams.get('fault') as Injection | null;
			const passes = number(url, 'passes');
			const fault = kind
				? {
						index: number(url, 'index'),
						passes,
						fault: kind,
						burn: number(url, 'burn') || undefined
					}
				: undefined;
			return Response.json(
				await coordinator().pool(
					{ name, run, width: number(url, 'k'), batch: number(url, 'batch') || 1 },
					number(url, 'n'),
					passes,
					fault
				)
			);
		}
		if (url.pathname === '/state') return Response.json(await coordinator().state());
		return new Response('not found', { status: 404 });
	}
} satisfies ExportedHandler<Env>;
