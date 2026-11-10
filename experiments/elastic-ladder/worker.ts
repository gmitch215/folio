import { DurableObject } from 'cloudflare:workers';
import dense from './build/fixture.wasm';
import lz4 from './build/lz4.wasm';
import trace from './build/trace.wasm';
import { lz4Codec } from './lz4.ts';
import type { Routable } from './service.ts';
import { ExecutorObject, route } from './service.ts';
import type { Sql } from './store.ts';
import { SqlBackend } from './store.ts';

interface Env {
	SECRET: string;
	EXEC: DurableObjectNamespace;
}

interface Storage {
	sql: Sql;
	deleteAll(): Promise<void>;
}

export class Executor extends DurableObject<Env> {
	private readonly object = new ExecutorObject({
		makeBackend: (rowBytes) => {
			const storage = this.ctx.storage as unknown as Storage;
			return new SqlBackend(storage.sql, rowBytes, () => storage.deleteAll());
		},
		codec: () => lz4Codec(lz4),
		dense,
		trace,
		clock: () => performance.now()
	});
	override fetch(request: Request) {
		return this.object.fetch(request);
	}
}

export default {
	fetch(request: Request, env: Env) {
		const colo = (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? null;
		return route(
			request,
			(name) => env.EXEC.get(env.EXEC.idFromName(name)) as Routable,
			env.SECRET,
			colo
		);
	}
};
