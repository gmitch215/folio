declare module 'cloudflare:workers' {
	export abstract class DurableObject<Env = unknown> {
		ctx: DurableObjectState;
		env: Env;
		constructor(ctx: DurableObjectState, env: Env);
		fetch(request: Request): Response | Promise<Response>;
	}
}

interface DurableObjectState {
	id: { toString(): string };
	storage: {
		get(key: string): Promise<unknown>;
		put(key: string, value: unknown): Promise<void>;
	};
}

interface DurableObjectNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): unknown;
}

interface ExportedHandler<Env> {
	fetch(request: Request, env: Env): Response | Promise<Response>;
}

interface WebSocket {
	accept(): void;
}

interface ResponseInit {
	webSocket?: WebSocket;
}

declare class WebSocketPair {
	0: WebSocket;
	1: WebSocket;
}
