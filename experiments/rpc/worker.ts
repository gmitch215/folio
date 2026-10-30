import kernel from './build/kernel.wasm';

interface Fetcher {
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface Env {
	PROBE_TOKEN: string;
	LANE1?: Fetcher;
	LANE2?: Fetcher;
	LANE3?: Fetcher;
	LANE4?: Fetcher;
	LANE_URLS?: string;
}

let instance: string | undefined;
let calls = 0;
const identity = () => (instance ??= crypto.randomUUID());

// xorshift over units of 65,536 words; the checksum keeps the loop from being removed
function spin(units: number) {
	let x = 0x9e3779b9 | 0;
	let sum = 0;
	for (let i = 0; i < units * 65536; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		sum = (sum + x) | 0;
	}
	return sum >>> 0;
}

async function lane(url: URL) {
	const units = Number(url.searchParams.get('units') ?? 0);
	const checksum = units ? spin(units) : 0;
	return Response.json({ instance: identity(), call: ++calls, units, checksum });
}

async function fan(url: URL, env: Env, auth: string) {
	const arm = url.searchParams.get('arm');
	const k = Number(url.searchParams.get('k'));
	const units = Number(url.searchParams.get('units'));
	const waves = Number(url.searchParams.get('waves') ?? 1);
	const bindings = [env.LANE1, env.LANE2, env.LANE3, env.LANE4];
	const urls: string[] = JSON.parse(env.LANE_URLS ?? '[]');
	const request = (index: number) => {
		const init = { headers: { authorization: auth } };
		return arm === 'binding'
			? bindings[index]!.fetch(`https://lane/spin?units=${units}`, init)
			: fetch(`${urls[index]}/spin?units=${units}`, init);
	};
	const start = performance.now();
	let settled: PromiseSettledResult<{ status: number; body: unknown }>[] = [];
	// waves run one after another so the span is long enough for a coarse clock
	for (let wave = 0; wave < waves; wave++)
		settled = await Promise.allSettled(
			Array.from({ length: k }, async (_, index) => {
				const response = await request(index);
				const text = await response.text();
				let body: unknown = text.slice(0, 120);
				try {
					body = JSON.parse(text);
				} catch {}
				return { status: response.status, body };
			})
		);
	const wallMs = performance.now() - start;
	return Response.json({
		arm,
		k,
		units,
		wallMs,
		coordinator: identity(),
		lanes: settled.map((item) =>
			item.status === 'fulfilled'
				? item.value
				: { error: String((item.reason as Error)?.message ?? item.reason) }
		)
	});
}

// #region transfer
const PART = 16384;
const WORDS = PART / 4;

type Slot = {
	memory: WebAssembly.Memory;
	run: (offset: number, words: number, rounds: number) => number;
	have: Set<string>;
	job?: string;
};
const slots = new Map<number, Slot>();

function slotFor(arena: number): Slot {
	let slot = slots.get(arena);
	if (!slot) {
		const memory = new WebAssembly.Memory({ initial: Math.max(1, Math.ceil(arena / 65536)) });
		const exports = new WebAssembly.Instance(kernel, { env: { memory } }).exports as any;
		slot = { memory, run: exports.run, have: new Set() };
		slots.set(arena, slot);
	}
	return slot;
}

// a lane keeps the partitions it has seen for the current job; a job is one coordinator request
async function run(request: Request) {
	const job = JSON.parse(request.headers.get('x-job') ?? '{}') as {
		arena: number;
		partition: number;
		rounds: number;
		job: string;
		send: [number, number][];
	};
	const body = new Uint8Array(await request.arrayBuffer());
	const slot = slotFor(job.arena);
	if (slot.job !== job.job) {
		slot.have.clear();
		slot.job = job.job;
	}
	const memory = new Uint8Array(slot.memory.buffer);
	let at = 0;
	for (const [offset, length] of job.send) {
		memory.set(body.subarray(at, at + length), offset);
		at += length;
	}
	const key = String(job.partition);
	if (!job.send.length && !slot.have.has(key)) return new Response('missing', { status: 409 });
	slot.have.add(key);
	const offset = job.partition * PART;
	const checksum = slot.run(offset, WORDS, job.rounds) >>> 0;
	return new Response(memory.slice(offset, offset + PART), {
		headers: { 'x-checksum': String(checksum), 'x-instance': identity() }
	});
}

function pattern(seed: number) {
	const words = new Uint32Array(WORDS);
	let x = (seed * 2654435761) | 1;
	for (let i = 0; i < WORDS; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		words[i] = x;
	}
	return new Uint8Array(words.buffer);
}

const digest = (bytes: Uint8Array) => {
	const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
	let sum = 0;
	for (let i = 0; i < words.length; i++) sum = (sum + Math.imul(words[i]!, 31 + (i & 7))) | 0;
	return sum >>> 0;
};

// four partitions, one per lane; serial runs them on lane 1 one after another
async function xfer(url: URL, env: Env, auth: string) {
	const mode = url.searchParams.get('mode') as 'serial' | 'full' | 'range' | 'retained';
	const arena = Number(url.searchParams.get('arena'));
	const waves = Number(url.searchParams.get('waves'));
	const rounds = Number(url.searchParams.get('rounds'));
	const lanes = [env.LANE1!, env.LANE2!, env.LANE3!, env.LANE4!];
	const job = crypto.randomUUID();
	let parts = [0, 1, 2, 3].map((p) => pattern(p + 1));
	const buffer = mode === 'full' ? new Uint8Array(arena) : undefined;
	let bytesOut = 0;
	let bytesIn = 0;
	const statuses = new Set<number>();
	const checksums: number[] = [0, 0, 0, 0];
	const instances = new Set<string>();
	const start = performance.now();
	const one = async (wave: number, p: number) => {
		const offset = p * PART;
		let send: [number, number][] = [];
		let body: Uint8Array = new Uint8Array(0);
		if (mode === 'full') {
			send = [[0, arena]];
			body = buffer!;
		} else if (mode === 'range' || wave === 0) {
			send = [[offset, PART]];
			body = parts[p]!;
		}
		bytesOut += body.byteLength;
		const response = await lanes[mode === 'serial' ? 0 : p]!.fetch('https://lane/run', {
			method: 'POST',
			headers: {
				authorization: auth,
				'x-job': JSON.stringify({ arena, partition: p, rounds, job, send })
			},
			body: body as unknown as BodyInit
		});
		statuses.add(response.status);
		if (response.status !== 200) {
			await response.body?.cancel();
			return;
		}
		parts[p] = new Uint8Array(await response.arrayBuffer());
		bytesIn += parts[p]!.byteLength;
		checksums[p] = Number(response.headers.get('x-checksum'));
		instances.add(response.headers.get('x-instance') ?? '');
	};
	for (let wave = 0; wave < waves && statuses.size <= 1 && !statuses.has(409); wave++) {
		if (buffer) for (let p = 0; p < 4; p++) buffer.set(parts[p]!, p * PART);
		if (mode === 'serial') for (let p = 0; p < 4; p++) await one(wave, p);
		else await Promise.all([0, 1, 2, 3].map((p) => one(wave, p)));
	}
	return Response.json({
		mode,
		arena,
		wallMs: performance.now() - start,
		bytesOut,
		bytesIn,
		statuses: [...statuses],
		checksums,
		digests: parts.map(digest),
		lanes: instances.size
	});
}
// #endregion

export default {
	async fetch(request: Request, env: Env) {
		const auth = request.headers.get('authorization') ?? '';
		if (auth !== `Bearer ${env.PROBE_TOKEN}`)
			return new Response('unauthorized', { status: 401 });
		const url = new URL(request.url);
		if (url.pathname === '/spin') return lane(url);
		if (url.pathname === '/fan') return fan(url, env, auth);
		if (url.pathname === '/run') return run(request);
		if (url.pathname === '/xfer') return xfer(url, env, auth);
		return new Response('not found', { status: 404 });
	}
};
