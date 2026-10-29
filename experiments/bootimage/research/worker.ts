import { DurableObject } from 'cloudflare:workers';
import metadata from 'folio:image-meta';
import target from 'folio:target';

interface Env {
	IMAGE: {
		idFromName(name: string): unknown;
		get(id: unknown): { fetch(request: Request): Promise<Response> };
	};
	ASSETS?: { fetch(request: Request): Promise<Response> };
	MODE: string;
	PROBE_TOKEN: string;
}
let moduleTag: string | undefined;
function checksum(bytes: Uint8Array) {
	let hash = 2166136261;
	for (const value of bytes) hash = Math.imul(hash ^ value, 16777619);
	return hash >>> 0;
}

export class ImageCost extends DurableObject<Env> {
	calls = 0;
	override async fetch(request: Request) {
		const url = new URL(request.url),
			tag = url.searchParams.get('tag') ?? '';
		const memory = new WebAssembly.Memory({ initial: metadata.pages, maximum: 65536 });
		const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
		for (const item of WebAssembly.Module.imports(target)) {
			imports[item.module] ??= {};
			imports[item.module]![item.name] =
				item.kind === 'memory'
					? memory
					: item.kind === 'global'
						? new WebAssembly.Global({ value: 'i32', mutable: true }, 0)
						: () => 0;
		}
		const instance = new WebAssembly.Instance(target, imports);
		let copiedBytes = 0,
			assetRequests = 0;
		if (this.env.MODE === 'assets') {
			if (!this.env.ASSETS) throw new Error('missing image assets');
			const view = new Uint8Array(memory.buffer);
			for (const chunk of metadata.chunks) {
				const response = await this.env.ASSETS.fetch(
					new Request(`https://assets.local/${chunk.file}`)
				);
				assetRequests++;
				if (!response.ok) throw new Error(`asset read failed: ${response.status}`);
				const data = new Uint8Array(await response.arrayBuffer());
				for (let index = 0; index < chunk.pages.length; index++)
					view.set(
						data.subarray(index * 65536, (index + 1) * 65536),
						chunk.pages[index]! * 65536
					);
				copiedBytes += data.length;
			}
			for (const [name, value] of Object.entries(metadata.globals))
				(instance.exports[name] as WebAssembly.Global).value = value;
		}
		const checked = url.searchParams.get('check') === '1';
		const actualChecksum = checked ? checksum(new Uint8Array(memory.buffer)) : undefined;
		const row = {
			probe: 'folio-image-cost',
			tag,
			mode: this.env.MODE,
			moduleTag: (moduleTag ??= crypto.randomUUID()),
			object: this.ctx.id.toString(),
			call: ++this.calls,
			memoryBytes: memory.buffer.byteLength,
			copiedBytes,
			assetRequests,
			checked,
			checksum: actualChecksum,
			equal: checked ? actualChecksum === metadata.expectedChecksum : undefined
		};
		console.log(JSON.stringify(row));
		return Response.json(row);
	}
}

export default {
	async fetch(request: Request, env: Env) {
		if (request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url);
		if (url.pathname === '/ready') return new Response('ready');
		return env.IMAGE.get(
			env.IMAGE.idFromName(url.searchParams.get('object') ?? 'reused')
		).fetch(request);
	}
};
