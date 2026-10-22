import { pagesChecksum } from './checksum.ts';

export interface Env {
	IMAGE: DurableObjectNamespace;
	PROBE_TOKEN?: string;
}

interface Entry {
	module: WebAssembly.Module;
	pages: number;
}

const maximumPages = 65536;
const entries: Record<string, Entry> = {};

export const register = (modules: Record<string, Entry>) => Object.assign(entries, modules);

// names this module instance; a changed tag between requests means the module was loaded again
const moduleTag = Math.random().toString(36).slice(2, 8);
let moduleCalls = 0;

function imports(module: WebAssembly.Module, memory?: WebAssembly.Memory) {
	const result: Record<string, Record<string, unknown>> = {};
	for (const item of WebAssembly.Module.imports(module)) {
		const space = (result[item.module] ??= {});
		if (item.kind === 'function') space[item.name] = () => 0;
		else if (item.kind === 'memory' && memory) space[item.name] = memory;
		else throw new Error(`unsupported import ${item.module}.${item.name} (${item.kind})`);
	}
	return result as WebAssembly.Imports;
}

const entry = (name: string) => {
	const found = entries[name];
	if (!found) throw new Error(`module ${name} is not in this deploy`);
	return found;
};

const mebibyte = 1048576;

export class BootImage {
	calls = 0;
	held?: { memory: WebAssembly.Memory; instance: WebAssembly.Instance };
	ballast: Uint8Array[] = [];

	async fetch(request: Request) {
		const url = new URL(request.url);
		this.calls++;
		moduleCalls++;
		const tags = { moduleTag, moduleCalls, objectCalls: this.calls };
		try {
			if (url.pathname === '/inst') return Response.json({ ...tags, ...this.inst(url) });
			if (url.pathname === '/memory') return Response.json({ ...tags, ...this.memory(url) });
			if (url.pathname === '/ballast') {
				const step = this.step(url);
				return Response.json({ ...tags, ...step }, { status: step.held ? 200 : 409 });
			}
			return new Response('Not found', { status: 404 });
		} catch (error: any) {
			return Response.json(
				{ ...tags, error: String(error?.stack ?? error) },
				{ status: 500 }
			);
		}
	}

	private inst(url: URL) {
		const name = url.searchParams.get('m') ?? '';
		const { module, pages: registered } = entry(name);
		const pages = Number(url.searchParams.get('pages')) || registered;
		const memory = new WebAssembly.Memory({ initial: pages, maximum: maximumPages });
		const instance = new WebAssembly.Instance(module, imports(module, memory));
		if (url.searchParams.get('keep') === '1') {
			this.held = { memory, instance };
			this.ballast = [];
		}
		const checked = url.searchParams.get('check') === '1';
		return {
			m: name,
			memoryBytes: memory.buffer.byteLength,
			checksum: checked ? pagesChecksum(memory.buffer) : undefined
		};
	}

	// one filled block per request, so a reset ends one request; a missing hold means the isolate was reset
	private step(url: URL) {
		if (!this.held) return { held: false as const };
		const block = new Uint8Array(Number(url.searchParams.get('mib') ?? 8) * mebibyte);
		block.fill(1);
		this.ballast.push(block);
		const ballastBytes = this.ballast.reduce((total, item) => total + item.byteLength, 0);
		const memoryBytes = this.held.memory.buffer.byteLength;
		return {
			held: true as const,
			step: this.ballast.length,
			ballastBytes,
			memoryBytes,
			liveBytes: ballastBytes + memoryBytes
		};
	}

	private memory(url: URL) {
		const mib = Number(url.searchParams.get('mib'));
		const mode = url.searchParams.get('mode');
		if (mode === 'own') {
			const { module } = entry(`own${mib}`);
			const instance = new WebAssembly.Instance(module, {});
			const memory = instance.exports.memory as WebAssembly.Memory;
			return { mode, mib, memoryBytes: memory.buffer.byteLength };
		}
		const memory = new WebAssembly.Memory({ initial: mib * 16, maximum: maximumPages });
		if (mode === 'import') {
			const { module } = entry('imp');
			new WebAssembly.Instance(module, imports(module, memory));
		} else if (mode !== 'create') throw new Error(`unknown mode ${mode}`);
		return { mode, mib, memoryBytes: memory.buffer.byteLength };
	}
}

export const authorized = (request: Request, env: Env) =>
	Boolean(env.PROBE_TOKEN) &&
	request.headers.get('authorization') === `Bearer ${env.PROBE_TOKEN}`;

export default {
	async fetch(request, env) {
		if (!authorized(request, env)) return new Response('Unauthorized', { status: 401 });
		const url = new URL(request.url);
		const stub = env.IMAGE.get(env.IMAGE.idFromName(url.searchParams.get('obj') ?? 'warm')) as {
			fetch(input: string, init?: RequestInit): Promise<Response>;
		};
		try {
			return await stub.fetch(`https://probe${url.pathname}${url.search}`);
		} catch (error: any) {
			return Response.json({ error: String(error?.message ?? error) }, { status: 502 });
		}
	}
} satisfies ExportedHandler<Env>;
