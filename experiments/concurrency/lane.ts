import { WorkerEntrypoint } from 'cloudflare:workers';
import { colo, frontDoor, spin } from './spin.ts';

interface Env {
	PROBE_TOKEN: string;
}

export default class Lane extends WorkerEntrypoint<Env> {
	execute(rounds: number, rid: number, slot: number) {
		return spin(rounds, rid, slot, 'lane');
	}

	where() {
		return colo();
	}

	// the direct arm reaches the lane through its own route, with no coordinator
	override async fetch(request: Request) {
		if (request.headers.get('authorization') !== `Bearer ${this.env.PROBE_TOKEN}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url);
		if (url.pathname === '/ready') return new Response('ready');
		if (url.pathname !== '/spin') return new Response('not found', { status: 404 });
		const rounds = Number(url.searchParams.get('rounds'));
		const rid = Number(url.searchParams.get('rid'));
		const slot = Number(url.searchParams.get('slot'));
		return Response.json({ ...spin(rounds, rid, slot, 'lane'), colo: frontDoor(request) });
	}
}
