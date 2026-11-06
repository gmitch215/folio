import fixture from './fixture.wasm';

const PAGE = 65536;
export class PageOwner {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
		this.cache = new Map();
	}
	async fetch(request) {
		const url = new URL(request.url);
		const page = Number(url.searchParams.get('page'));
		const offset = Number(url.searchParams.get('offset') ?? '0');
		const total = Number(url.searchParams.get('pages') ?? '3072');
		if (url.pathname === '/clear') {
			await this.ctx.storage.deleteAll();
			this.cache.clear();
			return Response.json({ cleared: true });
		}
		if (url.pathname === '/verify') {
			const owner = Number(url.searchParams.get('owner'));
			let checked = 0;
			for (let at = owner; at < total; at += 4) {
				const bytes = await this.ctx.storage.get(`page:${at}`);
				if (!(bytes instanceof Uint8Array) || bytes.length !== PAGE)
					throw new Error(`missing page ${at}`);
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				if (
					view.getUint32(0, true) !== (at + 17) % total ||
					view.getInt32(4, true) !== (Math.imul(at, 1664525) ^ 1013904223)
				)
					throw new Error('page header mismatch');
				for (let k = 8; k < PAGE; k++)
					if (bytes[k] !== (at & 255)) throw new Error('page byte mismatch');
				checked++;
			}
			if (checked !== total / 4) throw new Error('page denominator mismatch');
			return Response.json({
				exact: true,
				checkedPages: checked,
				checkedBytes: checked * PAGE,
				cacheBytes: this.cache.size * PAGE
			});
		}
		if (!Number.isInteger(page) || page < 0 || page >= total || offset < 0 || offset > PAGE - 4)
			throw new Error('invalid page address');
		if (url.pathname === '/fill') {
			const bytes = new Uint8Array(PAGE).fill(Number(url.searchParams.get('value')) & 255);
			await this.ctx.storage.put(`page:${page}`, bytes);
			this.cache.clear();
			this.cache.set(page, bytes);
			return new Response(null);
		}
		const bytes = this.cache.get(page) ?? (await this.ctx.storage.get(`page:${page}`));
		if (!bytes) throw new Error('missing page');
		this.cache.clear();
		this.cache.set(page, bytes);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (url.pathname === '/store') {
			view.setInt32(offset, Number(url.searchParams.get('value')), true);
			await this.ctx.storage.put(`page:${page}`, bytes);
			return new Response(null);
		}
		if (url.pathname === '/load') return Response.json({ value: view.getInt32(offset, true) });
		throw new Error('unknown page operation');
	}
}

export class Executor {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
	async fetch(request) {
		const url = new URL(request.url);
		const pages = Number(url.searchParams.get('pages'));
		const segment = Number(url.searchParams.get('segment') ?? '16');
		if (pages !== 3072 || segment !== 16) throw new Error('probe bounds');
		const resumed = url.searchParams.get('resume') === '1';
		const memory = new WebAssembly.Memory({ initial: 1, maximum: 8192 });
		const initial = await request.arrayBuffer();
		if (resumed) {
			if (initial.byteLength !== PAGE) throw new Error('bad checkpoint');
			new Uint8Array(memory.buffer).set(new Uint8Array(initial));
		} else {
			const data = new DataView(memory.buffer);
			data.setUint32(16, 1024, true);
			data.setUint32(20, PAGE, true);
		}
		let rewinding = resumed,
			completion = Number(url.searchParams.get('completion') ?? '0'),
			pending,
			exports;
		const hook = (kind, p, value, offset, width) => {
			if (rewinding) {
				exports.asyncify_stop_rewind();
				rewinding = false;
				return completion;
			}
			pending = { kind, p, value, offset, width };
			exports.asyncify_start_unwind(16);
			return 0;
		};
		exports = new WebAssembly.Instance(fixture, {
			env: { memory },
			folio: {
				load: (p, o, w) => hook('load', p, 0, o, w),
				store: (p, v, o, w) => hook('store', p, v, o, w),
				fill: (p, v, w) => hook('fill', p, v, 0, w),
				copy() {
					throw new Error('unsupported');
				},
				load64() {
					throw new Error('unsupported');
				},
				store64() {
					throw new Error('unsupported');
				},
				exhausted() {
					throw new Error('fuel exhausted');
				}
			}
		}).exports;
		exports.__folio_set_fuel(100000000);
		let faults = 0,
			rowWrites = 0,
			rowReads = 0;
		while (true) {
			if (rewinding) exports.asyncify_start_rewind(16);
			const result = exports.run(pages);
			if (!pending)
				return Response.json({
					done: true,
					result,
					faults,
					rowWrites,
					rowReads,
					wasmBytes: memory.buffer.byteLength
				});
			exports.asyncify_stop_unwind();
			const op = pending;
			pending = undefined;
			const at = (op.p >>> 0) + op.offset;
			if (at + op.width > pages * PAGE) throw new WebAssembly.RuntimeError('out of bounds');
			if (
				op.kind === 'fill'
					? op.width !== PAGE || at % PAGE
					: op.width !== 4 || at % PAGE > PAGE - 4
			)
				throw new Error('unsupported access');
			const page = Math.floor(at / PAGE),
				owner = this.env.PAGES.get(
					this.env.PAGES.idFromName(`${url.searchParams.get('run')}:${page % 4}`)
				);
			const query = new URLSearchParams({
				page: String(page),
				offset: String(at % PAGE),
				value: String(op.value),
				pages: String(pages)
			});
			const response = await owner.fetch(`https://owner/${op.kind}?${query}`, {
				method: 'POST'
			});
			if (!response.ok) throw new Error(`owner status ${response.status}`);
			completion = op.kind === 'load' ? (await response.json()).value : 0;
			if (op.kind === 'load') rowReads++;
			else rowWrites++;
			faults++;
			if (faults === segment)
				return new Response(memory.buffer, {
					headers: {
						'x-completion': String(completion),
						'x-faults': String(faults),
						'x-row-writes': String(rowWrites),
						'x-row-reads': String(rowReads),
						'x-wasm-bytes': String(memory.buffer.byteLength)
					}
				});
			rewinding = true;
		}
	}
}

export default {
	async fetch(request, env) {
		if (request.headers.get('authorization') !== `Bearer ${env.SECRET}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url),
			run = url.searchParams.get('run');
		if (url.pathname === '/ready') return Response.json({ ready: true });
		if (!run || !/^[a-f0-9-]{36}$/.test(run)) throw new Error('invalid run');
		if (url.pathname === '/run')
			return env.EXECUTORS.get(
				env.EXECUTORS.idFromName(`${run}:${url.searchParams.get('lane')}`)
			).fetch(request);
		if (url.pathname === '/verify' || url.pathname === '/clear') {
			const owner = Number(url.searchParams.get('owner'));
			if (!Number.isInteger(owner) || owner < 0 || owner >= 4)
				throw new Error('invalid owner');
			return env.PAGES.get(env.PAGES.idFromName(`${run}:${owner}`)).fetch(request);
		}
		return new Response('not found', { status: 404 });
	}
};
