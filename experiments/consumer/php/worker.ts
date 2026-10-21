import factory from '../build/php/glue.mjs';
import wasmModule from '../build/php/php.wasm';
import { PhpBase } from '../build/php/PhpBase.mjs';

export interface Env {
	PHP: DurableObjectNamespace;
	PROBE_TOKEN?: string;
}

// the emscripten glue reads self.location.href, which workerd does not define
(globalThis as any).location ??= { href: 'https://folio.invalid/worker.mjs' };

const mebibyte = 1048576;

const work = (n: number) =>
	`<?php $h = 'folio'; for ($i = 0; $i < ${n}; $i++) { $h = hash('sha256', $h . $i); } echo $h;`;

interface Instance {
	php: PhpBase;
	out: string[];
	binary: any;
	bootMs: number;
	diag: string[];
}

class Php extends PhpBase {
	constructor(diag: string[]) {
		super(Promise.resolve({ default: factory }), {
			ini: ['opcache.enable=0', 'opcache.enable_cli=0', 'memory_limit=-1'].join('\n'),
			printErr: (text: string) => diag.push(text),
			onAbort: (what: unknown) => diag.push(`abort: ${what}`),
			instantiateWasm(
				imports: WebAssembly.Imports,
				receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
			) {
				(imports.env as Record<string, unknown>).memory = new WebAssembly.Memory({
					initial: 1024,
					maximum: 65536
				});
				WebAssembly.instantiate(wasmModule, imports).then(
					(instance) => receive(instance, wasmModule),
					(error) => diag.push(`instantiate failed: ${error?.message ?? error}`)
				);
				return {};
			}
		});
	}
}

export async function bootPhp(): Promise<Instance> {
	const started = Date.now();
	const diag: string[] = [];
	const out: string[] = [];
	const php = new Php(diag);
	for (const type of ['output', 'error'])
		php.addEventListener(type, (event: any) => out.push(...[].concat(event.detail ?? [])));
	const binary = await Promise.race([
		php.binary,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`boot timeout; ${diag.join(' | ')}`)), 25000)
		)
	]);
	return { php, out, binary, bootMs: Date.now() - started, diag };
}

export const linearBytes = (binary: any): number | null =>
	(binary?.wasmMemory?.buffer ?? binary?.HEAPU8?.buffer)?.byteLength ?? null;

export async function exec(instance: Instance, code: string) {
	instance.out.length = 0;
	await instance.php._run(code);
	return instance.out.join('');
}

export class PhpProbe {
	instance?: Instance;
	hold: Uint8Array[] = [];

	async fetch(request: Request) {
		const url = new URL(request.url);
		const cold = !this.instance;
		try {
			const early = await this.early(url);
			if (early) return early;
			this.instance ??= await bootPhp();
			const instance = this.instance;
			if (url.pathname === '/boot') {
				return Response.json({
					cold,
					bootMs: instance.bootMs,
					version: await exec(instance, '<?php echo PHP_VERSION, " int", PHP_INT_SIZE;'),
					linearBytes: linearBytes(instance.binary)
				});
			}
			if (url.pathname === '/work') {
				const n = Number(url.searchParams.get('n') ?? 20000);
				const output = await exec(instance, work(n));
				return Response.json({ n, output, linearBytes: linearBytes(instance.binary) });
			}
			if (url.pathname === '/plateau') return this.plateau(url, instance);
			return new Response('Not found', { status: 404 });
		} catch (error: any) {
			return Response.json({ error: String(error?.stack ?? error) }, { status: 500 });
		}
	}

	// runs before PHP boots, so a variant can measure its own modules in a clean isolate
	protected async early(_url: URL): Promise<Response | undefined> {
		return undefined;
	}

	// streams one line per step so the last line the client reads names the size the isolate reached
	private plateau(url: URL, instance: Instance) {
		const kind = url.searchParams.get('kind') === 'php' ? 'php' : 'js';
		const step = Number(url.searchParams.get('step') ?? 8);
		const max = Number(url.searchParams.get('max') ?? 256);
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const encoder = new TextEncoder();
		void (async () => {
			for (let total = step; total <= max; total += step) {
				if (kind === 'js') {
					const block = new Uint8Array(step * mebibyte);
					block.fill(1);
					this.hold.push(block);
				} else {
					await exec(
						instance,
						`<?php $GLOBALS['hold'][] = str_repeat('x', ${step * mebibyte});`
					);
				}
				await writer.write(
					encoder.encode(
						`${JSON.stringify({ kind, addedMiB: total, linearBytes: linearBytes(instance.binary) })}\n`
					)
				);
			}
			await writer.close();
		})().catch((error) => writer.abort(error));
		return new Response(readable, { headers: { 'content-type': 'application/x-ndjson' } });
	}
}

export const authorized = (request: Request, env: Env) =>
	Boolean(env.PROBE_TOKEN) &&
	request.headers.get('authorization') === `Bearer ${env.PROBE_TOKEN}`;

export default {
	async fetch(request, env) {
		if (!authorized(request, env)) return new Response('Unauthorized', { status: 401 });
		const url = new URL(request.url);
		if (url.pathname === '/worker-ping') return Response.json({ ok: true });
		if (url.pathname === '/worker-boot') {
			// a plain Worker handler on Free has a 10 ms CPU limit; this boots PHP inside it
			const instance = await bootPhp();
			return Response.json({
				bootMs: instance.bootMs,
				linearBytes: linearBytes(instance.binary)
			});
		}
		if (url.pathname === '/worker-work') {
			const instance = await bootPhp();
			const n = Number(url.searchParams.get('n') ?? 20000);
			return Response.json({ n, output: await exec(instance, work(n)) });
		}
		const stub = env.PHP.get(env.PHP.idFromName('probe')) as {
			fetch(input: string, init?: RequestInit): Promise<Response>;
		};
		return stub.fetch(`https://probe${url.pathname}${url.search}`);
	}
} satisfies ExportedHandler<Env>;
