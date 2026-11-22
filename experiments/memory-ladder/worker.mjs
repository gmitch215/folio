import { DurableObject } from 'cloudflare:workers';

const MIB = 1048576;

export class Ladder extends DurableObject {
	inst = crypto.randomUUID().slice(0, 8);
	keep = [];
	a = null;
	b = null;

	held() {
		return (
			this.keep.reduce((sum, e) => sum + e.mib, 0) +
			(this.a ? this.a.mib : 0) +
			(this.b ? this.b.mib : 0)
		);
	}

	allocate(kind, mib, touch) {
		if (kind === 'ab') {
			const buf = new ArrayBuffer(mib * MIB);
			if (touch) {
				const u = new Uint8Array(buf);
				for (let i = 0; i < u.length; i += 4096) u[i] = 1;
			}
			return { mib, value: buf };
		}
		if (kind === 'wasm') {
			const memory = new WebAssembly.Memory({ initial: mib * 16 });
			if (touch) {
				const u = new Uint8Array(memory.buffer);
				for (let i = 0; i < u.length; i += 4096) u[i] = 1;
			}
			return { mib, value: memory };
		}
		if (kind === 'str') {
			const chunk = 'x'.repeat(MIB);
			let s = '';
			for (let i = 0; i < mib; i++) s += chunk;
			s.charCodeAt(0);
			return { mib, value: s };
		}
		throw new Error(`unknown kind ${kind}`);
	}

	async run({ kind, type, mib, k, touch, delay }) {
		if (kind === 'free') {
			const released = this.held();
			this.keep = [];
			this.a = null;
			this.b = null;
			return { inst: this.inst, kind, released };
		}
		if (kind === 'swap') {
			this.a = this.allocate('ab', mib, true);
			this.a = null;
			await scheduler.wait(delay);
			this.b = this.allocate('ab', mib, true);
			return { inst: this.inst, swapped: true };
		}
		if (kind === 'burn') {
			// date.now does not advance during synchronous code, so count instead
			let s = 0;
			for (let i = 0; i < delay * 1000000; i++) s = (s + i * 7) | 0;
			return { inst: this.inst, burned: s };
		}
		if (kind === 'chunks') {
			if (type === 'mixed') this.keep.push(this.allocate('ab', 64, touch));
			const chunkKind = type === 'mixed' ? 'wasm' : type;
			for (let i = 0; i < k; i++) this.keep.push(this.allocate(chunkKind, mib, touch));
			return { inst: this.inst, held: this.held() };
		}
		if (kind === 'drop') {
			this.keep = [];
			this.a = null;
			this.b = null;
			await scheduler.wait(delay);
			this.keep.push(this.allocate('wasm', mib, touch));
			return { inst: this.inst, held: this.held() };
		}
		this.keep.push(this.allocate(kind, mib, touch));
		return { inst: this.inst, kind, mib, held: this.held() };
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const name = url.searchParams.get('do');
		if (!name) return Response.json({ ok: false, error: 'missing do' }, { status: 400 });
		const params = {
			kind: url.searchParams.get('kind') ?? 'free',
			type: url.searchParams.get('type') ?? '',
			mib: Number(url.searchParams.get('mib') ?? 0),
			k: Number(url.searchParams.get('k') ?? 0),
			touch: url.searchParams.get('touch') === '1',
			delay: Number(url.searchParams.get('delay') ?? 0)
		};
		try {
			const stub = env.L.get(env.L.idFromName(name));
			return Response.json({ ok: true, ...(await stub.run(params)) });
		} catch (error) {
			return Response.json(
				{ ok: false, error: String(error?.message ?? error) },
				{ status: 500 }
			);
		}
	}
};
