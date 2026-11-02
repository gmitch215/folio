import { DurableObject } from 'cloudflare:workers';
import { colo, frontDoor, isolateId, spin } from './spin.ts';

type Spun = ReturnType<typeof spin>;

interface LaneStub {
	execute(rounds: number, rid: number, slot: number): Promise<Spun>;
	where(): Promise<string | null>;
}

interface Namespace {
	idFromName(name: string): unknown;
	get(id: unknown, options?: { locationHint?: string }): LaneStub;
}

interface Env {
	PROBE_TOKEN: string;
	LANE1: LaneStub;
	LANE2: LaneStub;
	LANE3: LaneStub;
	LANE4: LaneStub;
	LANES: Namespace;
}

const HINTS = ['wnam', 'enam', 'weur', 'apac'];
const ARMS = ['worker', 'worker-one', 'do-same', 'do-hint'];

export class LaneObject extends DurableObject<Env> {
	execute(rounds: number, rid: number, slot: number) {
		return spin(rounds, rid, slot, this.ctx.id.toString());
	}

	where() {
		return colo();
	}
}

// the arm decides which stub each of the k concurrent calls reaches
function stubFor(env: Env, arm: string, run: string, slot: number) {
	const lanes = [env.LANE1, env.LANE2, env.LANE3, env.LANE4];
	if (arm === 'worker') return lanes[slot]!;
	if (arm === 'worker-one') return lanes[0]!;
	const hinted = arm === 'do-hint';
	const id = env.LANES.idFromName(`${run}-${hinted ? 'hint' : 'same'}-${slot}`);
	return env.LANES.get(id, hinted ? { locationHint: HINTS[slot] } : undefined);
}

async function runCell(url: URL, env: Env, request: Request) {
	const arm = url.searchParams.get('arm') ?? '';
	const k = Number(url.searchParams.get('k'));
	const rounds = Number(url.searchParams.get('rounds'));
	const rid = Number(url.searchParams.get('rid'));
	const run = url.searchParams.get('run') ?? 'local';
	if (!ARMS.includes(arm) || !(k >= 1 && k <= 4))
		return Response.json({ error: 'bad request' }, { status: 400 });
	const began = performance.now();
	const calls = await Promise.all(
		Array.from({ length: k }, async (_, slot) => {
			const at = performance.now();
			try {
				const result = await stubFor(env, arm, run, slot).execute(rounds, rid, slot);
				return { slot, ok: true, ...result, wallMs: performance.now() - at };
			} catch (error) {
				return {
					slot,
					ok: false,
					error: String((error as Error)?.message ?? error).slice(0, 300),
					wallMs: performance.now() - at
				};
			}
		})
	);
	return Response.json({
		arm,
		k,
		rounds,
		rid,
		coordinatorIsolate: isolateId(),
		coordinatorColo: frontDoor(request),
		wallMs: performance.now() - began,
		calls
	});
}

// touches every lane and object once so each exists before a measured call
async function ready(env: Env, run: string, where: boolean) {
	const calls = [0, 1, 2, 3].flatMap((slot) =>
		ARMS.filter((arm) => arm !== 'worker-one').map(async (arm) => {
			const stub = stubFor(env, arm, run, slot);
			return where ? { arm, slot, colo: await stub.where() } : stub.execute(0, 0, slot);
		})
	);
	return Promise.all(calls);
}

export default {
	async fetch(request: Request, env: Env) {
		if (request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url);
		const run = url.searchParams.get('run') ?? 'local';
		if (url.pathname === '/run') return runCell(url, env, request);
		if (url.pathname === '/ready')
			return Response.json({ touched: (await ready(env, run, false)).length });
		if (url.pathname === '/where')
			return Response.json({
				coordinator: frontDoor(request),
				placements: await ready(env, run, true)
			});
		return new Response('not found', { status: 404 });
	}
} satisfies ExportedHandler<Env>;
