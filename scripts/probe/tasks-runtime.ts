import { writeFileSync } from 'node:fs';
import { Worker, type MessagePort } from 'node:worker_threads';
import {
	TaskConflictError,
	TaskError,
	TaskPool,
	createTaskLinks,
	peakConcurrency,
	type TaskInput,
	type TaskPoolOptions
} from '../../src/tasks.ts';

export interface Check {
	name: string;
	ok: boolean;
	detail: string;
	skipped?: boolean;
}

export interface TaskRuntimeReport {
	runtime: 'node' | 'bun';
	version: string;
	checks: Check[];
}

const TIMEOUT_MS = 10000;
const helpers = new URL('../../tests/helpers/', import.meta.url);
const pools: TaskPool[] = [];
const workers: Worker[] = [];

const waiterSource = `
const { parentPort, workerData } = require('node:worker_threads');
const cell = new Int32Array(workerData.cell);
parentPort.postMessage('ready');
const how = Atomics.wait(cell, 0, 0, 5000);
parentPort.postMessage(how + ' ' + Atomics.load(cell, 0));
`;

export function verdicts(report: Pick<TaskRuntimeReport, 'checks'>): string[] {
	return report.checks.map((check) => {
		if (check.skipped) return `${check.name}: skipped (${check.detail})`;
		return check.ok ? `${check.name}: ok` : `${check.name}: failed: ${check.detail}`;
	});
}

function errorText(error: unknown): string {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return text.split('\n')[0] ?? '';
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
	const got = JSON.stringify(actual);
	const want = JSON.stringify(expected);
	if (got !== want) throw new Error(`${label}: got ${got}, want ${want}`);
}

function expectTaskError(error: unknown, task: string, text: string): void {
	if (!(error instanceof TaskError)) throw new Error(`not a TaskError: ${errorText(error)}`);
	expectEqual(error.task, task, 'TaskError task');
	if (!error.message.includes(text)) throw new Error(`TaskError message: ${error.message}`);
}

async function thrownBy(run: () => unknown): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	return undefined;
}

function start(file: string, workerData: unknown, transfer: MessagePort[]): Worker {
	const worker = new Worker(new URL(file, helpers), { workerData, transferList: transfer });
	workers.push(worker);
	return worker;
}

function firstMessage<T = unknown>(worker: Worker): Promise<T> {
	return new Promise((done, fail) => {
		worker.once('message', done);
		worker.once('error', fail);
	});
}

async function startPool(count: number, options?: TaskPoolOptions): Promise<TaskPool> {
	const pool = new TaskPool(count, options);
	pools.push(pool);
	for (let index = 0; index < count; index++) {
		const link = pool.link(index);
		await firstMessage(start('task-worker.ts', { index, link }, [link.port]));
	}
	return pool;
}

// a blocking join cannot be interrupted, so a hang there stops the whole run
async function check(checks: Check[], name: string, run: () => Promise<string>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, fail) => {
		timer = setTimeout(() => fail(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
	});
	try {
		checks.push({ name, ok: true, detail: await Promise.race([run(), limit]) });
	} catch (error) {
		checks.push({ name, ok: false, detail: errorText(error) });
	} finally {
		clearTimeout(timer);
	}
}

async function poolCheck(
	checks: Check[],
	name: string,
	pool: TaskPool | undefined,
	run: (pool: TaskPool) => Promise<string>
): Promise<void> {
	if (!pool) {
		checks.push({ name, ok: false, detail: 'no pool, the start check failed', skipped: true });
		return;
	}
	await check(checks, name, () => run(pool));
}

function runtimeInfo(): Pick<TaskRuntimeReport, 'runtime' | 'version'> {
	const bun = (globalThis as { Bun?: { version: string } }).Bun;
	return bun
		? { runtime: 'bun', version: bun.version }
		: { runtime: 'node', version: process.version };
}

async function main(outPath: string): Promise<void> {
	const checks: Check[] = [];
	let shared: TaskPool | undefined;

	await check(checks, 'start two task workers from .ts entries', async () => {
		shared = await startPool(2);
		return 'two workers posted ready';
	});

	await poolCheck(checks, 'join returns text and bytes', shared, async (pool) => {
		const upper = pool.join(pool.submit('upper', 'folio'));
		expectEqual(upper.text(), 'FOLIO', 'upper text');
		const reversed = pool.join(pool.submit('bytes', new TextEncoder().encode('1,2,3')));
		expectEqual(Array.from(reversed.bytes), [3, 2, 1], 'bytes output');
		return `text ${upper.text()}, bytes ${Array.from(reversed.bytes).join(',')}`;
	});

	await poolCheck(checks, 'joinAsync resolves with the output', shared, async (pool) => {
		const result = await pool.joinAsync(pool.submit('upper', 'async'));
		expectEqual(result.text(), 'ASYNC', 'joinAsync text');
		return `text ${result.text()}`;
	});

	await poolCheck(checks, 'runSync joins in submission order', shared, async (pool) => {
		const results = pool.runSync([
			['sleep', '60'],
			['upper', 'b']
		]);
		expectEqual(
			results.map((result) => result.record.name),
			['sleep', 'upper'],
			'runSync order'
		);
		expectEqual(results[1]?.text(), 'B', 'second result');
		return `sleep on worker ${results[0]?.text()}, then upper B`;
	});

	await poolCheck(
		checks,
		'two sleeping tasks overlap; width 1 does not',
		shared,
		async (pool) => {
			pool.width = 2;
			pool.drain();
			try {
				await pool.run([
					['sleep', '150'],
					['sleep', '150']
				]);
				const wide = peakConcurrency(pool.drain());
				pool.width = 1;
				await pool.run([
					['sleep', '40'],
					['sleep', '40']
				]);
				const narrow = peakConcurrency(pool.drain());
				expectEqual(wide, 2, 'peak on two workers');
				expectEqual(narrow, 1, 'peak on width 1');
				return `peak ${wide} on two workers, ${narrow} on width 1`;
			} finally {
				pool.width = 2;
			}
		}
	);

	await poolCheck(checks, 'a throwing task rejects with TaskError', shared, async (pool) => {
		const sync = await thrownBy(() => pool.join(pool.submit('fail', 'x')));
		expectTaskError(sync, 'fail', 'refused x');
		const async = await thrownBy(() => pool.joinAsync(pool.submit('missing')));
		expectTaskError(async, 'missing', 'unknown task missing');
		expectEqual(pool.join(pool.submit('upper', 'still')).text(), 'STILL', 'pool after error');
		return 'join and joinAsync both reject with TaskError';
	});

	await check(checks, 'audit detects a stateful task with TaskConflictError', async () => {
		const audit = {
			run: (name: string, input: TaskInput) =>
				name === 'counter' ? '1' : String(input).toUpperCase()
		};
		const audited = await startPool(1, { audit });
		expectEqual(audited.join(audited.submit('upper', 'ok')).text(), 'OK', 'stateless task');
		expectEqual(audited.join(audited.submit('counter')).text(), '1', 'first counter');
		const error = await thrownBy(() => audited.join(audited.submit('counter')));
		if (!(error instanceof TaskConflictError))
			throw new Error(`not a TaskConflictError: ${errorText(error)}`);
		expectEqual(error.offset, 0, 'conflict offset');
		return `conflict on ${error.task} at byte ${error.offset}`;
	});

	await check(checks, 'an owner in a worker joins tasks served by other workers', async () => {
		const links = createTaskLinks(2);
		const servers = links.server.map((link, index) =>
			start('task-worker.ts', { index, link }, [link.port])
		);
		await Promise.all(servers.map((worker) => firstMessage(worker)));
		const owner = start(
			'task-owner.ts',
			{ links: links.owner },
			links.owner.map((link) => link.port)
		);
		const reply = await firstMessage<{ texts: string[]; peak: number }>(owner);
		expectEqual(reply.texts, ['0', '1', 'OWNER'], 'owner texts');
		expectEqual(reply.peak, 2, 'owner peak');
		return `texts ${reply.texts.join(', ')}, peak ${reply.peak}`;
	});

	await poolCheck(checks, 'thread CPU time is reported per task', shared, async (pool) => {
		const hook = typeof process.threadCpuUsage;
		const cpuMs = pool.join(pool.submit('spin', '30')).record.cpuMs;
		if (typeof cpuMs !== 'number' || cpuMs <= 0)
			throw new Error(`cpuMs ${cpuMs} (process.threadCpuUsage is ${hook})`);
		return `process.threadCpuUsage ${hook}, spin cpuMs ${cpuMs.toFixed(1)}`;
	});

	await check(checks, 'SharedArrayBuffer counter wakes a waiting worker', async () => {
		const cell = new Int32Array(new SharedArrayBuffer(4));
		const waiter = new Worker(waiterSource, { eval: true, workerData: { cell: cell.buffer } });
		workers.push(waiter);
		await firstMessage(waiter);
		Atomics.store(cell, 0, 7);
		const woken = Atomics.notify(cell, 0);
		const reply = await firstMessage<string>(waiter);
		if (!reply.endsWith(' 7')) throw new Error(`worker reply ${reply}`);
		return `worker wait returned "${reply}", notify woke ${woken}`;
	});

	for (const pool of pools) pool.close();
	await Promise.all(workers.map((worker) => worker.terminate()));

	const report: TaskRuntimeReport = { ...runtimeInfo(), checks };
	writeFileSync(outPath, `${JSON.stringify(report, null, '\t')}\n`);
	for (const line of verdicts(report)) console.log(line);
	process.exit(0);
}

if (import.meta.main) {
	const outPath = process.argv[2];
	if (!outPath) throw new Error('usage: tasks-runtime.ts OUT.json');
	await main(outPath);
}
