import { DatabaseSync } from 'node:sqlite';
import { LanePool, serveLane, type LaneCoordinator, type LaneHold } from '../src/managed/pool.ts';
import type { TaskValue } from '../src/managed/tasks.ts';
import type { SqlStorage } from '../src/memory/continuation.ts';

// the two classes have the shape of Durable Objects; here the lanes are plain objects, so this
// runs on Node. On Workers each Lane is a Durable Object with its own id and the coordinator's
// four methods are RPC methods that a lane calls through a stub.
class Lane {
	readonly #lane = serveLane({
		square: (args) => String(Number(args) ** 2)
	});

	work(coordinator: LaneCoordinator) {
		return this.#lane.work(coordinator);
	}
}

interface Storage {
	sql: SqlStorage;
	sync(): Promise<void>;
}

class Coordinator implements LaneCoordinator {
	readonly #pool: LanePool;

	constructor(ctx: { storage: Storage }, lanes: Lane[]) {
		this.#pool = new LanePool(ctx.storage.sql, {
			width: lanes.length,
			flush: () => ctx.storage.sync(),
			transport: { work: (lane) => lanes[lane]!.work(this) }
		});
	}

	claim() {
		return this.#pool.claim();
	}

	complete(id: string, attempt: number, result: TaskValue) {
		return this.#pool.complete(id, attempt, result);
	}

	fail(id: string, attempt: number, error: string) {
		return this.#pool.fail(id, attempt, error);
	}

	renew(holds: readonly LaneHold[]) {
		return this.#pool.renew(holds);
	}

	async sumOfSquares(count: number): Promise<number> {
		await this.#pool.submit(
			Array.from({ length: count }, (_, i) => ({
				id: `n${String(i).padStart(4, '0')}`,
				name: 'square',
				args: String(i)
			}))
		);
		await this.#pool.run();
		return this.#pool.fold((sum, result) => sum + result.json<number>(), 0);
	}

	// an alarm handler calls this after a reset, then arms the next alarm at the returned time
	async alarm() {
		return (await this.#pool.resume()).wake;
	}
}

// a Durable Object's storage over node:sqlite; every write is already durable
const db = new DatabaseSync(':memory:');
const storage: Storage = {
	sql: {
		exec(query, ...bindings) {
			const args = bindings.map((value) =>
				value instanceof ArrayBuffer ? new Uint8Array(value) : value
			);
			const statement = db.prepare(query);
			const rows = /^\s*SELECT|RETURNING/i.test(query)
				? (statement.all(...args) as Record<string, unknown>[])
				: (statement.run(...args), []);
			return { toArray: () => rows };
		}
	},
	sync: async () => {}
};

const coordinator = new Coordinator({ storage }, [new Lane(), new Lane(), new Lane(), new Lane()]);
console.log(await coordinator.sumOfSquares(100));
