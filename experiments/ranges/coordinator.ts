import { DurableObject } from 'cloudflare:workers';
import type { ManagedLaneTransport } from '../../src/managed.ts';
import { FolioLane, ManagedFolio } from '../../src/managed.ts';
import artifact, { helpers as helperModule, metadata } from './artifact.ts';
import type { Fill, Helpers } from './layout.ts';
import {
	ARENAS,
	BASE,
	fillArena,
	FILLS,
	helpers,
	hex,
	MAX_PAGES,
	seedPartitions
} from './layout.ts';

interface LaneStub {
	execute(frame: Uint8Array): Promise<Uint8Array>;
	info(): Promise<{ isolate: string; instance?: string }>;
}

interface Env {
	PROBE_TOKEN: string;
	// the Durable Object lanes are named from this, so each run gets new instances
	RUN_NAME?: string;
	// local tests only: 'throw' or 'malformed' for the object whose name ends with FAULT_SUFFIX
	FAULT?: string;
	FAULT_SUFFIX?: string;
	// local tests only: lanes run the inline-tracked module
	INLINE?: string;
	// local tests only: the owner asks lanes for run-encoded results
	RUNS?: string;
	LANE1?: LaneStub;
	LANE2?: LaneStub;
	LANE3?: LaneStub;
	LANE4?: LaneStub;
	LANEOBJ?: { getByName(name: string): LaneStub };
}

export class LaneObject extends DurableObject<Env> {
	#lane?: FolioLane;

	execute(frame: Uint8Array): Uint8Array {
		const { FAULT, FAULT_SUFFIX } = this.env;
		const fault =
			FAULT && FAULT_SUFFIX && this.ctx.id.name?.endsWith(FAULT_SUFFIX) ? FAULT : undefined;
		if (fault === 'throw') throw new Error('induced lane failure');
		this.#lane ??= new FolioLane(artifact.transactional, {
			initial: artifact.control.initial,
			maximum: artifact.control.maximum,
			dataSegments: [],
			...(this.env.INLINE ? { inline: { module: artifact.inline! } } : {})
		});
		const response = this.#lane.execute(frame);
		return fault === 'malformed' ? response.slice(0, response.length >> 1) : response;
	}

	info() {
		return { isolate: isolate(), instance: this.ctx.id.toString() };
	}
}

interface Meter {
	calls: number;
	bytesOut: number;
	bytesIn: number;
	failures: { lane: number; error: string }[];
	laneWallMs: number[];
}

interface Arena {
	key: string;
	memory: WebAssembly.Memory;
	tools: Helpers;
	pool?: ManagedFolio;
	poolWidth: number;
}

const arms = ['snapshot', 'ranges', 'serial'];
let identity: string | undefined;
const isolate = () => (identity ??= crypto.randomUUID());
let requests = 0;
let arena: Arena | undefined;
let meter: Meter = { calls: 0, bytesOut: 0, bytesIn: 0, failures: [], laneWallMs: [] };

// one arena at a time keeps the isolate under its memory limit; the driver groups cells by arena
function arenaFor(size: number, fill: Fill) {
	const key = `${size}-${fill}`;
	if (arena?.key === key) return { arena, created: false };
	arena = undefined;
	const memory = new WebAssembly.Memory({
		initial: size / 65536,
		maximum: MAX_PAGES,
		shared: true
	});
	const tools = helpers(helperModule, memory);
	fillArena(tools, new Uint8Array(memory.buffer), fill);
	arena = { key, memory, tools, poolWidth: 0 };
	return { arena, created: true };
}

const lanesOf = (env: Env) => (env.LANEOBJ ? 'do' : 'worker');

// a Durable Object stub belongs to the request that made it, and the warm arm reuses its
// transports across requests, so each call makes its own
function stubFor(env: Env, lane: number): LaneStub {
	if (env.LANEOBJ) return env.LANEOBJ.getByName(`${env.RUN_NAME ?? 'local'}-lane-${lane + 1}`);
	return [env.LANE1!, env.LANE2!, env.LANE3!, env.LANE4!][lane]!;
}

function transports(env: Env, width: number): ManagedLaneTransport[] {
	return Array.from({ length: width }, (_, lane) => ({
		execute: async (frame: Uint8Array) => {
			meter.calls++;
			meter.bytesOut += frame.length;
			const began = performance.now();
			try {
				const response = await stubFor(env, lane).execute(frame);
				meter.bytesIn += response.length;
				meter.laneWallMs.push(performance.now() - began);
				return response;
			} catch (error) {
				meter.laneWallMs.push(performance.now() - began);
				meter.failures.push({
					lane,
					error: String((error as Error)?.message ?? error).slice(0, 160)
				});
				throw error;
			}
		}
	}));
}

function number(url: URL, name: string, fallback: number, minimum: number, maximum: number) {
	const value = Number(url.searchParams.get(name) ?? fallback);
	if (!Number.isInteger(value) || value < minimum || value > maximum)
		throw new RangeError(`invalid ${name}`);
	return value;
}

function parameters(url: URL) {
	const size = number(url, 'arena', 131072, 131072, 33554432);
	if (!(ARENAS as readonly number[]).includes(size)) throw new RangeError('invalid arena');
	const fill = (url.searchParams.get('fill') ?? 'zero') as Fill;
	if (!FILLS.includes(fill)) throw new RangeError('invalid fill');
	return { size, fill };
}

async function run(url: URL, env: Env) {
	const arm = url.searchParams.get('arm') ?? '';
	if (!arms.includes(arm)) throw new RangeError('invalid arm');
	const { size, fill } = parameters(url);
	const waves = number(url, 'waves', 4, 1, 8);
	const rounds = number(url, 'rounds', 2, 0, 1048576);
	const width = number(url, 'width', 4, 2, 4);
	const fuel = number(url, 'fuel', 0, 0, 1000000000);
	const warm = url.searchParams.get('cache') === 'warm';
	const now = arenaFor(size, fill);
	const state = now.arena;
	seedPartitions(new Uint8Array(state.memory.buffer));
	meter = { calls: 0, bytesOut: 0, bytesIn: 0, failures: [], laneWallMs: [] };
	const reuse = arm === 'ranges' && warm && state.pool && state.poolWidth === width;
	const pool =
		reuse && state.pool
			? state.pool
			: new ManagedFolio(artifact, {
					lanes: transports(env, width),
					memory: state.memory,
					...(fuel ? { fuel } : {}),
					...(arm === 'ranges' ? { ranges: {} } : {}),
					...(env.RUNS ? { runs: true } : {})
				});
	const began = performance.now();
	const report = await pool.run('main', [BASE, waves, rounds], {
		parallel: arm === 'serial' ? 'off' : 'auto'
	});
	const wallMs = performance.now() - began;
	if (arm === 'ranges') {
		state.pool = pool;
		state.poolWidth = width;
	}
	return {
		arm,
		lanes: lanesOf(env),
		fuel,
		arena: size,
		fill,
		waves,
		rounds,
		width,
		requestedCache: arm === 'ranges' ? (warm ? 'warm' : 'cold') : null,
		wallMs,
		digest: hex(state.tools.digest(0, size)),
		value: report.values[0],
		report,
		diagnostics: pool.diagnostics.slice(0, 4),
		meter,
		arenaCreated: now.created,
		isolate: isolate(),
		request: ++requests,
		sourceSha256: metadata.sourceSha256,
		jspi: typeof (WebAssembly as any).Suspending === 'function'
	};
}

async function prepare(url: URL) {
	const { size, fill } = parameters(url);
	const began = performance.now();
	const now = arenaFor(size, fill);
	seedPartitions(new Uint8Array(now.arena.memory.buffer));
	return {
		arena: size,
		fill,
		created: now.created,
		wallMs: performance.now() - began,
		isolate: isolate()
	};
}

export default {
	async fetch(request: Request, env: Env) {
		if (request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url);
		try {
			if (url.pathname === '/ready')
				return Response.json(
					await Promise.all([0, 1, 2, 3].map((lane) => stubFor(env, lane).info()))
				);
			if (url.pathname === '/prepare') return Response.json(await prepare(url));
			if (url.pathname === '/memory') {
				if (!arena) return new Response('no arena', { status: 404 });
				return new Response(new Uint8Array(arena.memory.buffer).slice());
			}
			if (url.pathname !== '/run') return new Response('not found', { status: 404 });
			return Response.json(await run(url, env));
		} catch (error) {
			const status = error instanceof RangeError ? 400 : 500;
			return Response.json({ error: String((error as Error)?.stack ?? error) }, { status });
		}
	}
} satisfies ExportedHandler<Env>;
