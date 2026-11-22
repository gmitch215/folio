import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';
import { bundleModules } from '../../../experiments/lib/bundle.ts';
import { wranglerPath } from '../../../experiments/lib/cloudflare.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const guestPath = join(repository, 'build/continuation.wasm');
const TARGET_STEPS = 200000;
const EVERY = 10000;

interface Trace {
	slice: number;
	instance: string;
	restored: boolean;
	stop: string;
	epoch: number;
	steps: number;
}
interface Status {
	trace: Trace[];
	final: { steps: number; sha: string; bytes: number } | null;
}

// the uninterrupted run: same module, plain instance, no store
function reference() {
	const guest = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(guestPath)), {})
		.exports as unknown as {
		memory: WebAssembly.Memory;
		run(b: number): number;
		get_steps(): number;
	};
	guest.run(TARGET_STEPS);
	return {
		steps: guest.get_steps(),
		sha: createHash('sha256').update(new Uint8Array(guest.memory.buffer)).digest('hex'),
		bytes: guest.memory.buffer.byteLength
	};
}

// wrangler dry run bundles the worker as a deploy would; the guest is a wasm module import
function bundleWorker(): string {
	const outdir = mkdtempSync(join(tmpdir(), 'folio-continuation-bundle-'));
	execFileSync(
		process.execPath,
		[
			wranglerPath(),
			'deploy',
			'--dry-run',
			'--name',
			'continuation-test',
			'--outdir',
			outdir,
			'--compatibility-date',
			'2026-10-20',
			'tests/integration/memory/continuation.worker.ts'
		],
		{
			cwd: repository,
			env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
			stdio: 'pipe'
		}
	);
	return outdir;
}

let bundle: string;
let mf: Miniflare;
let expected: ReturnType<typeof reference>;

beforeAll(async () => {
	bundle = bundleWorker();
	expected = reference();
	mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: 'continuation',
					...bundleModules(bundle),
					compatibilityDate: '2026-10-20',
					durableObjects: { CONT: { className: 'Continuation', useSQLite: true } }
				}
			]
		})
	);
}, 120000);

afterAll(async () => {
	await mf?.dispose();
	if (bundle) rmSync(bundle, { recursive: true, force: true });
});

async function call(path: string) {
	return mf.dispatchFetch(`http://continuation.local${path}`);
}

async function chain(run: string, abort: number[]): Promise<Status> {
	const started = await call(`/start?run=${run}&every=${EVERY}&abort=${abort.join(',')}`);
	assert.equal(started.status, 202);
	const deadline = Date.now() + 90000;
	for (;;) {
		const status = (await (await call(`/status?run=${run}`)).json()) as Status;
		if (status.final) return status;
		assert.ok(
			Date.now() < deadline,
			`chain ${run} did not finish: ${status.trace.length} slices`
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

test('a chain of alarm slices with two forced aborts matches an uninterrupted run', async () => {
	const status = await chain('aborted', [4, 12]);

	assert.equal(status.final?.steps, expected.steps);
	assert.equal(status.final?.bytes, expected.bytes);
	assert.equal(status.final?.sha, expected.sha);

	const { trace } = status;
	assert.equal(trace.length, TARGET_STEPS / EVERY);
	assert.deepEqual(
		trace.map((row) => row.steps),
		Array.from({ length: trace.length }, (_, i) => (i + 1) * EVERY)
	);
	assert.deepEqual(
		trace.map((row) => row.slice),
		trace.map((_, i) => i + 1)
	);
	// the restart slices are the ones right after each abort
	assert.deepEqual(
		trace.filter((row) => row.restored).map((row) => row.slice),
		[5, 13]
	);
	assert.equal(new Set(trace.map((row) => row.instance)).size, 3);
	assert.equal(trace.at(-1)?.stop, 'finished');
});

test('the same chain without aborts matches the reference on one object instance', async () => {
	const status = await chain('control', []);

	assert.equal(status.final?.sha, expected.sha);
	assert.equal(status.trace.length, TARGET_STEPS / EVERY);
	assert.equal(new Set(status.trace.map((row) => row.instance)).size, 1);
	assert.ok(status.trace.every((row) => !row.restored));
});
