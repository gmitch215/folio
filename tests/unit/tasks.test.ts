import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { afterEach, test } from 'vitest';
import {
	TaskConflictError,
	TaskError,
	TaskPool,
	createTaskLinks,
	peakConcurrency,
	type TaskInput,
	type TaskPoolOptions
} from '../../src/tasks.ts';

const open: { pool: TaskPool; workers: Worker[] }[] = [];

async function start(count: number, options?: TaskPoolOptions) {
	const pool = new TaskPool(count, options);
	const workers: Worker[] = [];
	for (let index = 0; index < count; index++) {
		const link = pool.link(index);
		const worker = new Worker(new URL('../helpers/task-worker.ts', import.meta.url), {
			workerData: { index, link },
			transferList: [link.port]
		});
		workers.push(worker);
		await new Promise((done, fail) => {
			worker.once('message', done);
			worker.once('error', fail);
		});
	}
	open.push({ pool, workers });
	return pool;
}

afterEach(async () => {
	for (const { pool, workers } of open.splice(0)) {
		pool.close();
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
});

test('a joined task returns the worker output with text and json accessors', async () => {
	const pool = await start(1);
	const upper = pool.join(pool.submit('upper', 'folio'));
	assert.equal(upper.text(), 'FOLIO');
	assert.deepEqual(upper.bytes, new TextEncoder().encode('FOLIO'));
	const sum = pool.join(pool.submitJson('sum', [1, 2, 3, 4]));
	assert.equal(sum.json<number>(), 10);
});

test('byte input and byte output cross the thread boundary unchanged', async () => {
	const pool = await start(1);
	const result = pool.join(pool.submit('bytes', new TextEncoder().encode('1,2,3')));
	assert.deepEqual(result.bytes, Uint8Array.from([3, 2, 1]));
});

test('run joins in submission order whatever the duration of each task', async () => {
	const pool = await start(2);
	const results = await pool.run([
		['sleep', '60'],
		['sleep', '1'],
		['sleep', '1'],
		['sleep', '1']
	]);
	assert.deepEqual(
		results.map((result) => result.record.id),
		['0:0', '1:1', '0:2', '1:3']
	);
});

test('runSync and joinAsync match join', async () => {
	const pool = await start(2);
	const sync = pool.runSync([
		['upper', 'a'],
		['upper', 'b']
	]);
	assert.deepEqual(
		sync.map((result) => result.text()),
		['A', 'B']
	);
	const later = await pool.joinAsync(pool.submit('upper', 'c'));
	assert.equal(later.text(), 'C');
});

test('tasks spread over the first width workers and width can change', async () => {
	const pool = await start(3);
	pool.width = 2;
	const narrow = await pool.run([['where'], ['where'], ['where'], ['where']]);
	assert.deepEqual(
		narrow.map((result) => result.text()),
		['worker 0', 'worker 1', 'worker 0', 'worker 1']
	);
	pool.width = 3;
	const wide = await pool.run([['where'], ['where'], ['where']]);
	assert.deepEqual(
		wide.map((result) => result.text()),
		['worker 0', 'worker 1', 'worker 2']
	);
	assert.throws(() => (pool.width = 4), RangeError);
	assert.throws(() => (pool.width = 0), RangeError);
});

test('two tasks on two workers overlap in time and the records show it', async () => {
	const pool = await start(2);
	pool.drain();
	await pool.run([
		['sleep', '150'],
		['sleep', '150']
	]);
	const records = pool.drain();
	assert.equal(records.length, 2);
	assert.equal(peakConcurrency(records), 2);
	for (const record of records) {
		assert.ok(record.endMs - record.startMs >= 140);
		assert.ok(record.startMs >= record.submitMs);
		assert.equal(record.inputBytes, 3);
	}
	assert.deepEqual(pool.drain(), []);
});

test('the same two tasks on one worker run back to back', async () => {
	const pool = await start(2);
	pool.width = 1;
	pool.drain();
	await pool.run([
		['sleep', '40'],
		['sleep', '40']
	]);
	assert.equal(peakConcurrency(pool.drain()), 1);
});

test('records carry thread CPU time for a busy task', async () => {
	const pool = await start(1);
	const result = pool.join(pool.submit('spin', '30'));
	assert.equal(typeof result.record.cpuMs, 'number');
	assert.ok(result.record.cpuMs! > 0);
	assert.equal(result.record.outputBytes, 2);
});

test('a throwing task rejects the join with the task name and worker', async () => {
	const pool = await start(1);
	const handle = pool.submit('fail', 'x');
	assert.throws(
		() => pool.join(handle),
		(error: unknown) => {
			assert.ok(error instanceof TaskError);
			assert.equal(error.task, 'fail');
			assert.equal(error.worker, 0);
			assert.match(error.message, /refused x/);
			return true;
		}
	);
	await assert.rejects(pool.joinAsync(pool.submit('missing')), TaskError);
	assert.equal(pool.join(pool.submit('upper', 'still works')).text(), 'STILL WORKS');
});

test('a handle joins once and unknown handles are refused', async () => {
	const pool = await start(1);
	const handle = pool.submit('upper', 'a');
	pool.join(handle);
	assert.throws(() => pool.join(handle), /unknown or already joined/);
	assert.throws(() => pool.join('9:9'), /unknown or already joined/);
});

test('audit passes a stateless task and rejects one that kept state in its worker', async () => {
	const audit = {
		run: (name: string, input: TaskInput) =>
			name === 'counter' ? '1' : String(input).toUpperCase()
	};
	const pool = await start(1, { audit });
	assert.equal(pool.join(pool.submit('upper', 'ok')).text(), 'OK');
	assert.equal(pool.join(pool.submit('counter')).text(), '1');
	const handle = pool.submit('counter');
	assert.throws(
		() => pool.join(handle),
		(error: unknown) => {
			assert.ok(error instanceof TaskConflictError);
			assert.equal(error.task, 'counter');
			assert.equal(error.offset, 0);
			return true;
		}
	);
});

test('audit every n checks only the sampled tasks', async () => {
	const seen: string[] = [];
	const pool = await start(1, {
		audit: {
			every: 2,
			run: (name, input) => {
				seen.push(String(input));
				return String(input).toUpperCase();
			}
		}
	});
	await pool.run([
		['upper', 'a'],
		['upper', 'b'],
		['upper', 'c'],
		['upper', 'd']
	]);
	assert.deepEqual(seen, ['a', 'c']);
});

test('tasks and audits retain submitted bytes when the caller reuses a buffer', async () => {
	const decoder = new TextDecoder();
	const seen: string[] = [];
	const pool = await start(1, {
		audit: {
			run: (_, input) => {
				const text = typeof input === 'string' ? input : decoder.decode(input);
				seen.push(text);
				return text.toUpperCase();
			}
		}
	});
	for (const input of [
		Uint8Array.of(97),
		Buffer.from('a'),
		new Uint8Array(new SharedArrayBuffer(1))
	]) {
		input[0] = 97;
		const handle = pool.submit('upper', input);
		input[0] = 98;
		assert.equal(pool.join(handle).text(), 'A');
	}
	assert.deepEqual(seen, ['a', 'a', 'a']);
});

test('audit reports a length difference at the end of the shorter output', async () => {
	const pool = await start(1, { audit: { run: () => 'ABCD' } });
	const handle = pool.submit('upper', 'abcdef');
	assert.throws(
		() => pool.join(handle),
		(error: unknown) => error instanceof TaskConflictError && error.offset === 4
	);
});

test('an owner that runs in a worker joins tasks served by other workers', async () => {
	const links = createTaskLinks(2);
	const servers = links.server.map(
		(link, index) =>
			new Worker(new URL('../helpers/task-worker.ts', import.meta.url), {
				workerData: { index, link },
				transferList: [link.port]
			})
	);
	await Promise.all(
		servers.map(
			(worker) =>
				new Promise((done, fail) => {
					worker.once('message', done);
					worker.once('error', fail);
				})
		)
	);
	const owner = new Worker(new URL('../helpers/task-owner.ts', import.meta.url), {
		workerData: { links: links.owner },
		transferList: links.owner.map((link) => link.port)
	});
	const reply = await new Promise<{ texts: string[]; peak: number }>((done, fail) => {
		owner.once('message', done);
		owner.once('error', fail);
	});
	assert.deepEqual(reply.texts, ['0', '1', 'OWNER']);
	assert.equal(reply.peak, 2);
	await Promise.all([owner, ...servers].map((worker) => worker.terminate()));
});

test('a pool attached to existing links has no server ends to hand out', () => {
	const links = createTaskLinks(1);
	const pool = new TaskPool(links.owner);
	assert.throws(() => pool.link(0), /attached/);
	assert.throws(() => new TaskPool([]), RangeError);
	pool.close();
	links.server[0]!.port.close();
});

test('pool arguments and use after close are validated', async () => {
	assert.throws(() => new TaskPool(0), RangeError);
	assert.throws(() => new TaskPool(1.5), RangeError);
	assert.throws(() => createTaskLinks(0), RangeError);
	assert.throws(() => new TaskPool(1, { audit: { run: () => '', every: 0 } }), RangeError);
	const pool = await start(1);
	assert.throws(() => pool.link(1), RangeError);
	assert.equal(pool.size, 1);
	pool.close();
	assert.throws(() => pool.submit('upper'), /closed/);
});

test('peak concurrency counts touching intervals as separate', () => {
	assert.equal(peakConcurrency([]), 0);
	assert.equal(
		peakConcurrency([
			{ startMs: 0, endMs: 10 },
			{ startMs: 10, endMs: 20 }
		]),
		1
	);
	assert.equal(
		peakConcurrency([
			{ startMs: 0, endMs: 10 },
			{ startMs: 5, endMs: 15 },
			{ startMs: 8, endMs: 9 }
		]),
		3
	);
});
