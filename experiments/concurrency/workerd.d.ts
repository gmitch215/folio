declare module 'cloudflare:workers' {
	export abstract class WorkerEntrypoint<Env = unknown> {
		env: Env;
		fetch?(request: Request): Response | Promise<Response>;
	}

	export abstract class DurableObject<Env = unknown> {
		ctx: { id: { toString(): string } };
		env: Env;
		constructor(ctx: { id: { toString(): string } }, env: Env);
	}
}

interface ExportedHandler<Env> {
	fetch(request: Request, env: Env): Response | Promise<Response>;
}
