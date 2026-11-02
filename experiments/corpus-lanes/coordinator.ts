import { DurableObject } from 'cloudflare:workers';
import type { ManagedLaneTransport, ManagedReport } from '../../src/managed.ts';
import { FolioLane, ManagedFolio } from '../../src/managed.ts';
import { artifacts } from './artifact.ts';
import { driverOf, entryOf, fill, layoutFor, outputBytes } from './drivers.ts';
import type { Tally } from './measure.ts';
import { emptyTally, measuring } from './measure.ts';

interface LaneStub {
	execute(frame: Uint8Array): Promise<Uint8Array>;
	info(): Promise<{ isolate: string; instance?: string }>;
}

interface Env {
	PROBE_TOKEN: string;
	// the lane objects are named from this, so each run gets new instances
	RUN_NAME?: string;
	// local tests only: 'throw' or 'malformed' for the object whose name ends with FAULT_SUFFIX
	FAULT?: string;
	FAULT_SUFFIX?: string;
	LANEOBJ: { getByName(name: string): LaneStub };
}

// object names are `<run>.<driver>.lane<n>`; the driver picks the tracked module
const driverOfName = (name: string) => name.split('.')[1] ?? '';

export class LaneObject extends DurableObject<Env> {
	#lane?: FolioLane;

	execute(frame: Uint8Array): Uint8Array {
		const name = this.ctx.id.name ?? '';
		const { FAULT, FAULT_SUFFIX } = this.env;
		const fault = FAULT && FAULT_SUFFIX && name.endsWith(FAULT_SUFFIX) ? FAULT : undefined;
		if (fault === 'throw') throw new Error('induced lane failure');
		const artifact = artifacts[driverOfName(name)];
		if (!artifact) throw new Error('unknown driver');
		this.#lane ??= new FolioLane(artifact.transactional!, {
			initial: artifact.control!.initial,
			maximum: artifact.control!.maximum
		});
		const response = this.#lane.execute(frame);
		return fault === 'malformed' ? response.slice(0, response.length >> 1) : response;
	}

	info() {
		return { isolate: isolate(), instance: this.ctx.id.toString() };
	}
}

// the warm arm keeps its pool, and so its transports, across requests; they count into these
const meter: Meter = { calls: 0, bytesOut: 0, bytesIn: 0, failures: [], laneWallMs: [] };
const tally: Tally = emptyTally();

let identity: string | undefined;
const isolate = () => (identity ??= crypto.randomUUID());
let requests = 0;

interface Owner {
	key: string;
	memory: WebAssembly.Memory;
	pool?: ManagedFolio;
}
let owner: Owner | undefined;

// a Durable Object stub belongs to the request that made it, and the warm arm reuses its
// transports across requests, so each call makes its own
function transports(env: Env, driver: string, width: number) {
	return Array.from({ length: width }, (_, lane): ManagedLaneTransport => {
		const raw: ManagedLaneTransport = {
			execute: async (frame: Uint8Array) => {
				meter.calls++;
				meter.bytesOut += frame.length;
				const began = performance.now();
				try {
					const response = await env.LANEOBJ.getByName(
						`${env.RUN_NAME ?? 'local'}.${driver}.lane${lane + 1}`
					).execute(frame);
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
		};
		return measuring(raw, tally);
	});
}

interface Meter {
	calls: number;
	bytesOut: number;
	bytesIn: number;
	failures: { lane: number; error: string }[];
	laneWallMs: number[];
}

function integer(url: URL, name: string, fallback: number, minimum: number, maximum: number) {
	const value = Number(url.searchParams.get(name) ?? fallback);
	if (!Number.isInteger(value) || value < minimum || value > maximum)
		throw new RangeError(`invalid ${name}`);
	return value;
}

const hex = (buffer: ArrayBuffer) =>
	[...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function run(url: URL, env: Env) {
	const id = url.searchParams.get('driver') ?? '';
	const driver = driverOf(id);
	const artifact = artifacts[id];
	if (!artifact) throw new RangeError('driver not built');
	const arm = url.searchParams.get('arm') ?? '';
	if (!['ranges', 'snapshot', 'serial'].includes(arm)) throw new RangeError('invalid arm');
	const n = integer(url, 'n', 16, 1, 4096);
	const k = integer(url, 'k', 0, 0, 4096);
	const width = integer(url, 'width', 4, 2, 8);
	const maxBytes = integer(url, 'maxbytes', 0, 0, 1048576);
	const fuel = integer(url, 'fuel', 0, 0, 1000000000);
	const warm = url.searchParams.get('cache') === 'warm';
	const layout = layoutFor(driver, n);
	const key = `${id}-${n}`;
	if (owner?.key !== key) {
		owner = undefined;
		owner = {
			key,
			memory: new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages })
		};
	}
	const state = owner;
	const bytes = new Uint8Array(state.memory.buffer);
	bytes.fill(0, layout.out, layout.out + n * driver.slot);
	fill(bytes, driver, layout, n);
	Object.assign(meter, { calls: 0, bytesOut: 0, bytesIn: 0, failures: [], laneWallMs: [] });
	Object.assign(tally, emptyTally());
	const reuse = arm === 'ranges' && warm && state.pool;
	const pool =
		reuse && state.pool
			? state.pool
			: new ManagedFolio(artifact, {
					lanes: transports(env, id, width),
					imports: { env: { memory: state.memory } },
					memory: state.memory,
					...(maxBytes ? { maxTransactionBytes: maxBytes } : {}),
					...(fuel ? { fuel } : {}),
					...(arm === 'ranges' ? { ranges: {} } : {})
				});
	const entry = entryOf(layout, n, k);
	const began = performance.now();
	const report: ManagedReport = await pool.run(entry.name, entry.args, {
		parallel: arm === 'serial' ? 'off' : 'auto',
		maximumWorkers: width
	});
	const wallMs = performance.now() - began;
	if (arm === 'ranges') state.pool = pool;
	const digest = hex(
		await crypto.subtle.digest('SHA-256', outputBytes(bytes, driver, layout, n).slice())
	);
	return {
		arm,
		driver: id,
		n,
		k,
		width,
		maxBytes,
		fuel,
		requestedCache: arm === 'ranges' ? (warm ? 'warm' : 'cold') : null,
		wallMs,
		digest,
		report,
		diagnostics: pool.diagnostics.slice(0, 4),
		meter: structuredClone(meter),
		tracked: {
			reads: tally.reads,
			writes: tally.writes,
			exhaustedCalls: tally.exhaustedCalls,
			laneCalls: tally.calls
		},
		isolate: isolate(),
		request: ++requests,
		sourceSha256: artifact.sourceSha256
	};
}

export default {
	async fetch(request: Request, env: Env) {
		if (request.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url);
		try {
			if (url.pathname === '/ready') {
				const id = url.searchParams.get('driver') ?? 'synthetic-sum';
				return Response.json(
					await Promise.all(
						[1, 2, 3, 4].map((lane) =>
							env.LANEOBJ.getByName(
								`${env.RUN_NAME ?? 'local'}.${id}.lane${lane}`
							).info()
						)
					)
				);
			}
			if (url.pathname !== '/run') return new Response('not found', { status: 404 });
			return Response.json(await run(url, env));
		} catch (error) {
			const status = error instanceof RangeError ? 400 : 500;
			return Response.json({ error: String((error as Error)?.stack ?? error) }, { status });
		}
	}
} satisfies ExportedHandler<Env>;
