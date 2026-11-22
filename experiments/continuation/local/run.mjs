// usage: node run.mjs [1|2|3|4 ...]   (default: all four)
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RestoreRefused, Store } from './checkpoint.mjs';
import {
	Kill,
	PAGE,
	SAVED_LCG,
	SAVED_LEFT,
	execute,
	hashOf,
	loadModules,
	newMemory,
	setPeriod,
	sha256
} from './host.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runs = join(here, 'runs');
const K = 16;

function build() {
	const jobs = [
		['local-guest.wat', 'guest.wasm', []],
		['local-guest-nopoll.wat', 'guest-nopoll.wasm', []],
		['hash.wat', 'hash.wasm', ['--enable-multi-memory']]
	];
	for (const [src, out, flags] of jobs) {
		execFileSync('wat2wasm', [
			...flags,
			join(here, '..', 'guests', src),
			'-o',
			join(runs, out)
		]);
	}
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function p90(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.ceil(0.9 * s.length) - 1];
}

function span(xs) {
	return [Math.min(...xs), Math.max(...xs)];
}

function round(x) {
	return Math.round(x * 1000) / 1000;
}

function xorshift(seed) {
	let x = seed | 0 || 1;
	return () => {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		return x >>> 0;
	};
}

function fill(memory) {
	const u = new Uint32Array(memory.buffer);
	const next = xorshift(2463534242);
	for (let i = 0; i < u.length; i++) u[i] = next();
}

// writes a random word into `count` distinct pages, so each dirty page changes its hash
function dirty(memory, pages, count, next) {
	const dv = new DataView(memory.buffer);
	const order = Array.from({ length: pages }, (_, i) => i);
	for (let i = 0; i < count; i++) {
		const j = i + (next() % (pages - i));
		[order[i], order[j]] = [order[j], order[i]];
	}
	for (let i = 0; i < count; i++) {
		const off = order[i] * PAGE + (next() % (PAGE / 8)) * 8;
		dv.setBigUint64(off, (BigInt(next()) << 32n) | BigInt(next()), true);
	}
}

async function reference(mods, pages, steps) {
	const memory = newMemory(pages);
	const out = await execute({
		mods,
		memory,
		steps,
		k: 0,
		onYield: async () => {
			throw new Error('reference run yielded');
		}
	});
	return { value: out.value, sha: sha256(out.memory) };
}

// onYield handler; `before` runs while the guest is suspended and may throw Kill
// gaps: handler exit to the next handler entry (one K-step segment of guest work, the JSPI resume and suspend)
function recorder({ alarm, before }) {
	const rec = { yields: 0, ms: [], gaps: [], lastExit: null };
	rec.onYield = async (state) => {
		const t0 = performance.now();
		if (rec.lastExit !== null) rec.gaps.push(t0 - rec.lastExit);
		rec.yields += 1;
		if (before) await before(state, rec.yields);
		if (alarm) await new Promise((r) => setImmediate(r));
		rec.lastExit = performance.now();
		rec.ms.push(rec.lastExit - t0);
	};
	return rec;
}

// amortized: (run with yields - run without) / yields, the same guest work in both arms
async function timed(mods, pages, steps, alarm) {
	const ref = await reference(mods, pages, steps);
	const amortized = [];
	const gaps = [];
	const handler = [];
	let events = 0;
	let valueEqual = true;
	const never = async () => {
		throw new Error('k=0 arm yielded');
	};
	for (let r = 0; r < 5; r++) {
		const offMem = newMemory(pages);
		const t0 = performance.now();
		await execute({ mods, memory: offMem, steps, k: 0, onYield: never });
		const tOff = performance.now() - t0;
		const rec = recorder({ alarm });
		const onMem = newMemory(pages);
		const t1 = performance.now();
		const got = await execute({ mods, memory: onMem, steps, k: K, onYield: rec.onYield });
		const tOn = performance.now() - t1;
		amortized.push((tOn - tOff) / rec.yields);
		gaps.push(...rec.gaps);
		handler.push(...rec.ms);
		events = rec.yields + 1;
		valueEqual &&= got.value === ref.value;
	}
	return {
		alarm,
		events,
		repeats: 5,
		amortized_per_event_ms_median: round(median(amortized)),
		amortized_per_event_ms_range: span(amortized).map(round),
		gap_samples: gaps.length,
		gap_median_ms: round(median(gaps)),
		gap_p90_ms: round(p90(gaps)),
		handler_median_ms: round(median(handler)),
		handler_p90_ms: round(p90(handler)),
		value_equal: valueEqual
	};
}

async function run1(mods) {
	const pages = 1024;
	const S = 200 * K;
	const ref = await reference(mods, pages, S);
	const rec = recorder({ alarm: true });
	const got = await execute({
		mods,
		memory: newMemory(pages),
		steps: S,
		k: K,
		onYield: rec.onYield
	});
	const exact = {
		pages,
		K,
		steps: S,
		events: rec.yields + 1,
		value: String(got.value),
		value_equal: got.value === ref.value,
		sha_equal: sha256(got.memory) === ref.sha
	};
	const alarm = await timed(mods, pages, 1000 * K, true);
	const bare = await timed(mods, pages, 1000 * K, false);
	return { exact, timing: [alarm, bare] };
}

async function run2(mods) {
	const pages = 1024;
	const S = 200 * K;
	const ref = await reference(mods, pages, S);
	const file = join(runs, 'durable-64.sqlite');
	rmSync(file, { force: true });
	const store = new Store(file, 'page');
	const kills = new Set([50, 120, 170]);
	const checkpoints = [];
	const restores = [];
	const rec = recorder({
		alarm: true,
		before: async (state, n) => {
			if (n % 10 === 0) {
				state.current.quiesce();
				const mem = state.current.memory;
				const dv = new DataView(mem.buffer);
				const lcg = dv.getBigUint64(SAVED_LCG, true).toString(16);
				const left = Number(dv.getBigUint64(SAVED_LEFT, true));
				checkpoints.push({
					yield: n,
					...store.checkpoint(mem, hashOf(mods, mem), left, lcg)
				});
			}
			if (kills.has(n)) {
				kills.delete(n);
				throw new Kill(`killed at yield ${n}`);
			}
		}
	});
	const restore = async () => {
		const mem = newMemory(pages);
		const r = store.restore(mem, hashOf(mods, mem));
		restores.push({
			epoch: r.epoch,
			steps_left: r.steps,
			rowsLoaded: r.rowsLoaded,
			pagesVerified: r.pagesVerified,
			ms: round(r.ms)
		});
		return r;
	};
	const got = await execute({
		mods,
		memory: newMemory(pages),
		steps: S,
		k: K,
		onYield: rec.onYield,
		restore
	});
	const corrupted = store.corruptNewest();
	let refusal = 'NOT REFUSED';
	try {
		const mem = newMemory(pages);
		store.restore(mem, hashOf(mods, mem));
	} catch (err) {
		refusal =
			err instanceof RestoreRefused
				? `refused: ${err.message}`
				: `other error: ${err.message}`;
	}
	store.close();
	return {
		pages,
		K,
		steps: S,
		events: rec.yields + 1,
		value_equal: got.value === ref.value,
		sha_equal: sha256(got.memory) === ref.sha,
		checkpoints,
		restores,
		corrupted,
		refusal
	};
}

async function run3(mods) {
	const table = [];
	for (const mib of [32, 64, 128]) {
		const pages = mib * 16;
		const memory = newMemory(pages);
		fill(memory);
		const hash = hashOf(mods, memory);
		const hashMs = [];
		const shaMs = [];
		for (let r = 0; r < 5; r++) {
			let t = performance.now();
			hash.hashPages(0, pages);
			hashMs.push(performance.now() - t);
			t = performance.now();
			sha256(memory);
			shaMs.push(performance.now() - t);
		}
		table.push({
			kind: 'hash-pass',
			mib,
			pages,
			wasm_ms: hashMs.map(round),
			sha256_ms: shaMs.map(round),
			wasm_median_ms: round(median(hashMs)),
			sha256_median_ms: round(median(shaMs)),
			wasm_GiBs: round(mib / 1024 / (median(hashMs) / 1000)),
			sha256_GiBs: round(mib / 1024 / (median(shaMs) / 1000))
		});
		for (const mode of ['page', 'group']) {
			for (const dirtyMiB of [0, 1, 16, 64]) {
				if (dirtyMiB > mib) continue;
				// fresh memory per config: a shared one would carry dirty state between modes
				const cfgMemory = newMemory(pages);
				fill(cfgMemory);
				const cfgHash = hashOf(mods, cfgMemory);
				const file = join(runs, `cost-${mib}-${mode}-${dirtyMiB}.sqlite`);
				rmSync(file, { force: true });
				const store = new Store(file, mode);
				const base = store.checkpoint(cfgMemory, cfgHash, 0, '0');
				const next = xorshift(1000 + mib * 7 + dirtyMiB);
				const reps = [];
				for (let r = 0; r < 5; r++) {
					dirty(cfgMemory, pages, dirtyMiB * 16, next);
					reps.push(store.checkpoint(cfgMemory, cfgHash, 0, '0'));
				}
				store.close();
				rmSync(file, { force: true });
				table.push({
					kind: 'checkpoint',
					mib,
					mode,
					dirtyMiB,
					base_ms: round(base.ms),
					base_rows: base.rows,
					ms: reps.map((c) => round(c.ms)),
					median_ms: round(median(reps.map((c) => c.ms))),
					range_ms: span(reps.map((c) => c.ms)).map(round),
					rows: reps.map((c) => c.rows),
					pagesChanged: reps.map((c) => c.pagesChanged),
					MiB_written: reps.map((c) => round(c.bytes / 1048576))
				});
			}
		}
	}
	return table;
}

async function run4(mods) {
	const pages = 1024;
	const S = 16000;
	const never = 0x7fffffff;
	const arms = {
		poll: () => {
			const memory = newMemory(pages);
			setPeriod(memory, never);
			const { exports } = new WebAssembly.Instance(mods.guest, {
				env: {
					memory,
					yield: () => {
						throw new Error('poll arm yielded');
					}
				}
			});
			const t = performance.now();
			const v = exports.work(S);
			return { ms: performance.now() - t, v, memory };
		},
		plain: () => {
			const memory = newMemory(pages);
			const { exports } = new WebAssembly.Instance(mods.nopoll, { env: { memory } });
			const t = performance.now();
			const v = exports.work(S);
			return { ms: performance.now() - t, v, memory };
		}
	};
	arms.poll();
	arms.plain();
	const polled = [];
	const plain = [];
	const ratios = [];
	let valuesEqual = true;
	let shaEqual = null;
	for (let i = 0; i < 7; i++) {
		const order = i % 2 ? ['plain', 'poll'] : ['poll', 'plain'];
		const res = {};
		for (const name of order) res[name] = arms[name]();
		polled.push(res.poll.ms);
		plain.push(res.plain.ms);
		ratios.push(res.poll.ms / res.plain.ms);
		valuesEqual &&= res.poll.v === res.plain.v;
		if (i === 0) shaEqual = sha256(res.poll.memory) === sha256(res.plain.memory);
	}
	return {
		pages,
		steps: S,
		pairs: 7,
		polled_ms: polled.map(round),
		plain_ms: plain.map(round),
		ratios: ratios.map((r) => round(r)),
		median_polled_ms: round(median(polled)),
		median_plain_ms: round(median(plain)),
		median_ratio: round(median(ratios)),
		ratio_range: span(ratios).map((r) => round(r)),
		values_equal: valuesEqual,
		sha_equal_first_pair: shaEqual
	};
}

build();
const mods = loadModules();
const cpu = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim();
const want = process.argv.slice(2);
const todo = want.length ? want : ['1', '2', '3', '4'];
const out = { node: process.version, cpu, host: 'Mac, not workerd', K, runs: {} };
for (const id of todo) {
	const t0 = performance.now();
	if (id === '1') out.runs.run1 = await run1(mods);
	if (id === '2') out.runs.run2 = await run2(mods);
	if (id === '3') out.runs.run3 = await run3(mods);
	if (id === '4') out.runs.run4 = await run4(mods);
	out.runs[`run${id}_wall_s`] = round((performance.now() - t0) / 1000);
	writeFileSync(join(runs, `results-l1-run${id}.json`), JSON.stringify(out, null, 2));
	console.log(`run ${id} done in ${round((performance.now() - t0) / 1000)} s`);
}
console.log(JSON.stringify(out, null, 2));
