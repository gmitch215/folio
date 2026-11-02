import { WorkerEntrypoint } from 'cloudflare:workers';
import { FolioLane } from '../../src/managed.ts';
import artifact from './artifact.ts';

interface Env {
	// local tests only: 'throw' fails every frame, 'malformed' truncates every response
	FAULT?: string;
	// local tests only: lanes run the inline-tracked module
	INLINE?: string;
}

let lane: FolioLane | undefined;
let isolate: string | undefined;

export default class Lane extends WorkerEntrypoint<Env> {
	execute(frame: Uint8Array): Uint8Array {
		if (this.env.FAULT === 'throw') throw new Error('induced lane failure');
		lane ??= new FolioLane(artifact.transactional, {
			initial: artifact.control.initial,
			maximum: artifact.control.maximum,
			dataSegments: [],
			...(this.env.INLINE ? { inline: { module: artifact.inline! } } : {})
		});
		const response = lane.execute(frame);
		return this.env.FAULT === 'malformed' ? response.slice(0, response.length >> 1) : response;
	}

	info() {
		return { isolate: (isolate ??= crypto.randomUUID()) };
	}

	override fetch() {
		return new Response('lane', { status: 404 });
	}
}
