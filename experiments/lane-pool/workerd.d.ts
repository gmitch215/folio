declare module 'cloudflare:workers' {
	interface SqlCursor {
		toArray(): Record<string, unknown>[];
	}

	interface ObjectContext {
		id: { toString(): string; name?: string };
		storage: {
			sync(): Promise<void>;
			sql: {
				exec(
					query: string,
					...bindings: (string | number | null | ArrayBuffer)[]
				): SqlCursor;
			};
		};
		abort(reason?: string): never;
	}

	export abstract class DurableObject<Env = unknown> {
		ctx: ObjectContext;
		env: Env;
		constructor(ctx: ObjectContext, env: Env);
	}
}

type RpcStub<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R
		? (...args: A) => Promise<Awaited<R>>
		: never;
};

interface DurableObjectNamespace<T> {
	idFromName(name: string): unknown;
	get(id: unknown): RpcStub<T>;
}

interface ExportedHandler<Env> {
	fetch(request: Request, env: Env): Response | Promise<Response>;
}
