import { DurableObject } from 'cloudflare:workers';

// random values are refused in global scope, so the id is made on first use
let isolateId;
const isolate = () => (isolateId ??= crypto.randomUUID());
const PAGE = 65536;
const MIB = 1048576;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Mem extends DurableObject {
	mem = null;
	touched = 0;
	alloc({ mib }) {
		this.mem = new WebAssembly.Memory({ initial: (mib * MIB) / PAGE, maximum: (mib * MIB) / PAGE });
		return { bytes: this.mem.buffer.byteLength };
	}
	// one byte per 4 KiB host page, so every page of the slice is written
	touch({ from, mib }) {
		const bytes = new Uint8Array(this.mem.buffer);
		const end = Math.min((from + mib) * MIB, bytes.length);
		let count = 0;
		for (let at = from * MIB; at < end; at += 4096, count++) bytes[at] = 1;
		this.touched += count;
		return { touched: this.touched };
	}
	// an open request keeps the object, and so its isolate, resident while the meter samples
	async hold({ ms }) {
		await sleep(ms);
		return { held: ms, bytes: this.mem?.buffer.byteLength ?? 0, touched: this.touched };
	}
	async fetch(request) {
		const op = new URL(request.url).pathname.slice(1);
		if (!['alloc', 'touch', 'hold'].includes(op))
			return Response.json({ error: `unknown op ${op}` }, { status: 404 });
		try {
			return Response.json({ isolate: isolate(), ...(await this[op](await request.json())) });
		} catch (error) {
			return Response.json({ error: String(error), isolate: isolate() }, { status: 500 });
		}
	}
}

export class M00 extends Mem {}
export class M01 extends Mem {}
export class M02 extends Mem {}
export class M03 extends Mem {}
export class M04 extends Mem {}
export class M05 extends Mem {}
export class M06 extends Mem {}
export class M07 extends Mem {}
export class M08 extends Mem {}
export class M09 extends Mem {}
export class M10 extends Mem {}
export class M11 extends Mem {}
export class M12 extends Mem {}
export class M13 extends Mem {}
export class M14 extends Mem {}
export class M15 extends Mem {}
export class M16 extends Mem {}
export class M17 extends Mem {}
export class M18 extends Mem {}
export class M19 extends Mem {}
export class M20 extends Mem {}
export class M21 extends Mem {}
export class M22 extends Mem {}
export class M23 extends Mem {}
export class M24 extends Mem {}
export class M25 extends Mem {}

export default {
	async fetch(request, env) {
		if (request.headers.get('authorization') !== `Bearer ${env.SECRET}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url);
		if (url.pathname === '/ready') return Response.json({ ready: true });
		const [, cls, name, op] = url.pathname.split('/');
		const ns = env[cls];
		if (!/^M\d\d$/.test(cls) || !ns || !name || !op)
			return new Response('not found', { status: 404 });
		const response = await ns
			.get(ns.idFromName(name))
			.fetch(`https://do/${op}`, { method: 'POST', body: request.body });
		const out = new Response(response.body, response);
		out.headers.set('x-front-colo', request.cf?.colo ?? '');
		return out;
	}
};
