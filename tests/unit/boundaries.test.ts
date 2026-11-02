import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
	buildContextSubjects,
	buildCorpusContextSubjects,
	corpusContext,
	corpusEntry,
	ownContext
} from '../../scripts/research/affine-state-build.ts';
import {
	CONTEXT_ADDRESS,
	ContextKernel,
	DATA_ADDRESS,
	contextSubject,
	pick,
	stateSerial,
	type ContextSubject
} from '../../src/affine-state.ts';
import { recordBoundaries, verifyBoundaries, type BoundaryLog } from '../../src/boundaries.ts';
import { TaskPool } from '../../src/tasks.ts';

const worker = new URL('../../scripts/research/affine-context-worker.ts', import.meta.url);
const open: { pool: TaskPool; workers: Worker[] }[] = [];

let seed = 0x1badcafe;
const next = () => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return seed >>> 0;
};
const random = (size: number) => Uint8Array.from({ length: size }, () => next() & 255);

interface Chain {
	name: string;
	wasm: string;
	subject: ContextSubject;
	pool: TaskPool;
	serial: (input: Uint8Array, state?: Uint8Array) => Uint8Array;
}

let own: Record<string, string>;
let corpus: Record<string, string>;
const chains = new Map<string, Chain>();

beforeAll(() => {
	own = buildContextSubjects();
	corpus = buildCorpusContextSubjects();
}, 120000);

afterAll(async () => {
	for (const { pool, workers } of open.splice(0)) {
		pool.close();
		await Promise.all(workers.map((w) => w.terminate()));
	}
});

function chain(name: string, width = 4): Chain | undefined {
	let found = chains.get(name);
	if (found) return found;
	const wasm = own[name] ?? corpus[name];
	if (!wasm) return undefined;
	const module = new WebAssembly.Module(readFileSync(wasm));
	const context = name in own ? ownContext(name) : corpusContext(name, wasm);
	const subject = contextSubject(
		module,
		name in own ? `${name}_update` : corpusEntry[name]!,
		context
	);
	const pool = new TaskPool(width);
	const workers: Worker[] = [];
	for (let index = 0; index < width; index++) {
		const link = pool.link(index);
		workers.push(
			new Worker(worker, {
				workerData: {
					link,
					wasm,
					layout: subject.layout,
					context: subject.context,
					state: subject.state
				},
				transferList: [link.port]
			})
		);
	}
	open.push({ pool, workers });
	found = { name, wasm, subject, pool, serial: stateSerial(subject) };
	chains.set(name, found);
	return found;
}

const names = ['mix8', 'sha256', 'sha1', 'md5'];
const step = 20000;
const size = 300000;

function edit(input: Uint8Array, at: number): Uint8Array {
	const out = Uint8Array.from(input);
	out[at] = out[at]! ^ 0x5a;
	return out;
}

let lastJoined = 0;

// verify, check the result against the serial state, and check that every task was joined
function check(c: Chain, input: Uint8Array, log: BoundaryLog, label: string, initial?: Uint8Array) {
	c.pool.drain();
	const result = verifyBoundaries(c.pool, c.subject, input, log, { initial });
	assert.deepEqual(result.state, c.serial(input, initial), `${c.name} ${label}`);
	lastJoined = c.pool.drain().length;
	assert.ok(lastJoined <= result.tasks, `${c.name} ${label} joined every task`);
	return result;
}

describe('recordBoundaries', () => {
	test('records the serial state at every step and ends where one call ends', () => {
		for (const name of names) {
			const c = chain(name);
			if (!c) continue;
			const input = random(100003);
			const { state, log } = recordBoundaries(c.subject, input, { step: 8192 });
			assert.deepEqual(state, c.serial(input), name);
			assert.equal(log.starts.length, Math.ceil(input.length / 8192));
			assert.deepEqual(log.starts[0], pick(c.subject.context, c.subject.state));
			for (const k of [1, 5, 12])
				assert.deepEqual(
					log.starts[k],
					c.serial(input.subarray(0, k * 8192)),
					`${name} ${k}`
				);
		}
	});

	test('the drivers are the corpus functions: the digest matches node:crypto', () => {
		const algorithm: Record<string, [string, number]> = {
			sha256: ['sha256', 32],
			sha1: ['sha1', 20],
			md5: ['md5', 16]
		};
		for (const [name, [hash, bytes]] of Object.entries(algorithm)) {
			const c = chain(name);
			if (!c) continue;
			const input = random(100000);
			const { state } = recordBoundaries(c.subject, input, { step: 30000 });
			const kernel = new ContextKernel(readFileSync(c.wasm), `${name}_final`);
			const image = Uint8Array.from(c.subject.context);
			c.subject.state.forEach((o, k) => (image[o] = state[k]!));
			kernel.put(CONTEXT_ADDRESS, image);
			kernel.raw([CONTEXT_ADDRESS, DATA_ADDRESS]);
			assert.deepEqual(
				Buffer.from(kernel.get(DATA_ADDRESS, bytes)),
				createHash(hash).update(input).digest(),
				name
			);
		}
	});

	test('empty input, a step larger than the input and an invalid step', () => {
		const c = chain('mix8')!;
		const initial = pick(c.subject.context, c.subject.state);
		const empty = recordBoundaries(c.subject, new Uint8Array(0), { step: 10 });
		assert.deepEqual(empty.state, initial);
		assert.equal(empty.log.starts.length, 0);
		const input = random(100);
		const big = recordBoundaries(c.subject, input, { step: 1000 });
		assert.equal(big.log.starts.length, 1);
		assert.deepEqual(big.state, c.serial(input));
		assert.throws(() => recordBoundaries(c.subject, input, { step: 0 }), RangeError);
	});
});

describe('verifyBoundaries', () => {
	test('an identical rerun runs every chunk once, in parallel, and equals serial', () => {
		for (const name of names) {
			const c = chain(name);
			if (!c) continue;
			const input = random(size);
			const { log } = recordBoundaries(c.subject, input, { step });
			const result = check(c, input, log, 'identical');
			assert.equal(result.chunks, 15);
			assert.equal(result.tasks, 15);
			assert.equal(result.validated, 14);
			assert.equal(result.mismatchAt, -1);
			assert.equal(result.fallbackBytes, 0);
			assert.equal(result.stale, false);
			assert.equal(lastJoined, 15);
			assert.deepEqual(result.log, log);
		}
	});

	test('an edit shows up at its own chunk and the result still equals serial', () => {
		for (const name of ['sha256', 'sha1', 'md5']) {
			const c = chain(name);
			if (!c) continue;
			const input = random(size);
			const { log } = recordBoundaries(c.subject, input, { step });
			for (const [label, at] of [
				['suffix', 14 * step + 7000],
				['middle', 7 * step + 100],
				['prefix', 200]
			] as [string, number][]) {
				const edited = edit(input, at);
				const result = check(c, edited, log, label);
				// the last chunk has no recorded end to compare with, so its end state is the result
				const hit = Math.floor(at / step);
				assert.equal(result.mismatchAt, hit === 14 ? -1 : hit, `${name} ${label}`);
				assert.equal(lastJoined, result.tasks);
				assert.equal(result.stale, false);
				assert.equal(result.fallbackBytes > 0, label !== 'suffix');
				// the returned log is valid for the edited bytes: the next run is all parallel
				const again = check(c, edited, result.log, `${label} again`);
				assert.equal(again.mismatchAt, -1);
				assert.equal(again.fallbackBytes, 0);
				assert.equal(again.validated, 14);
			}
		}
	});

	test('early cutoff: an edit that leaves a chunk end state alone does not touch the rest', () => {
		const c = chain('mix8')!;
		const input = random(size);
		const { log } = recordBoundaries(c.subject, input, { step });
		const edited = edit(input, 7 * step + 100);
		assert.notDeepEqual(edited, input);
		const result = check(c, edited, log, 'cutoff');
		assert.equal(result.mismatchAt, -1);
		assert.equal(result.fallbackBytes, 0);
		assert.equal(result.validated, 14);
		assert.deepEqual(result.log, log);
		// the last eight bytes of a chunk are the state, so an edit there is a difference
		const near = check(c, edit(input, 7 * step + step - 3), log, 'near the end');
		assert.equal(near.mismatchAt, 7);
		assert.ok(near.fallbackBytes > 0);
	});

	test('longer, shorter, and not a multiple of the step', () => {
		for (const name of names) {
			const c = chain(name);
			if (!c) continue;
			const input = random(size);
			const { log } = recordBoundaries(c.subject, input, { step });
			const longer = Uint8Array.from([...input, ...random(54321)]);
			const grown = check(c, longer, log, 'longer');
			assert.equal(grown.mismatchAt, -1);
			assert.equal(grown.fallbackBytes, 54321);
			assert.equal(grown.log.starts.length, Math.ceil(longer.length / step));
			assert.equal(check(c, longer, grown.log, 'longer again').fallbackBytes, 0);
			for (const keep of [1, step - 1, step, step + 1, 123457, size - 1])
				check(c, input.subarray(0, keep), log, `shorter ${keep}`);
		}
	});

	test('empty input and one chunk', () => {
		const c = chain('mix8')!;
		const log = recordBoundaries(c.subject, random(50000), { step }).log;
		const empty = check(c, new Uint8Array(0), log, 'empty');
		assert.equal(empty.tasks, 0);
		const small = random(77);
		const result = check(c, small, log, 'small');
		assert.equal(result.chunks, 1);
		assert.equal(result.mismatchAt, -1);
		const one = recordBoundaries(c.subject, small, { step: 1000 }).log;
		assert.equal(check(c, small, one, 'one chunk log').tasks, 1);
	});

	test('a stale or mismatched log never changes the result', () => {
		for (const name of names) {
			const c = chain(name);
			if (!c) continue;
			const input = random(size);
			const good = recordBoundaries(c.subject, input, { step }).log;
			const other = recordBoundaries(c.subject, random(size), { step }).log;
			const otherStep = recordBoundaries(c.subject, input, { step: 33333 }).log;
			const forged: BoundaryLog = {
				step,
				starts: good.starts.map((s, k) => (k === 6 ? random(s.length) : s))
			};
			const width = c.subject.state.length;
			const logs: [string, BoundaryLog][] = [
				['other bytes', other],
				['other step', otherStep],
				['forged start', forged],
				['truncated', { step, starts: good.starts.slice(0, 4) }],
				['one start', { step, starts: good.starts.slice(0, 1) }],
				['no starts', { step, starts: [] }],
				['step zero', { step: 0, starts: good.starts }],
				['step not an integer', { step: 1.5, starts: good.starts }],
				['wrong width', { step, starts: good.starts.map((s) => s.slice(1)) }],
				['wrong first start', { step, starts: [random(width), ...good.starts.slice(1)] }],
				['shifted', { step, starts: good.starts.slice(1) }]
			];
			for (const [label, log] of logs) {
				const result = check(c, input, log, label);
				if (label.includes('start') && label !== 'forged start' && label !== 'one start')
					assert.equal(result.stale, true, label);
			}
			// the same log against edited bytes
			check(c, edit(input, 12345), forged, 'forged and edited');
		}
	});

	test('a log recorded for another initial state is stale and the result uses the given one', () => {
		const c = chain('mix8')!;
		const input = random(100000);
		const initial = random(c.subject.state.length);
		const log = recordBoundaries(c.subject, input, { step, initial }).log;
		const other = check(c, input, log, 'default initial');
		assert.equal(other.stale, true);
		const same = check(c, input, log, 'same initial', initial);
		assert.equal(same.stale, false);
		assert.equal(same.mismatchAt, -1);
	});
});
