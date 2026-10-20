import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { beforeEach, test, vi } from 'vitest';
import { transpileProbe } from '../../experiments/browser/prepare.ts';
import { browserLane } from '../../experiments/browser/probe.ts';

const launcher = vi.hoisted(() => ({ launch: (async () => undefined) as (...args: any[]) => any }));

vi.mock('@cloudflare/playwright', () => ({ launch: (...args: any[]) => launcher.launch(...args) }));
vi.mock('../../build/fixture.wasm', () => ({ default: new Uint8Array([2]) }));
vi.mock('../../build/sharing.wasm', () => ({ default: new Uint8Array([1]) }));
vi.mock('../../experiments/browser/build/probe.js', () => ({
	default: 'export function browserLane() {}\nexport async function runBrowserProbe() {}'
}));

const { BrowserGate, default: entry } = await import('../../experiments/browser/worker.ts');

beforeEach(() => {
	launcher.launch = async () => {
		throw new Error('Unauthenticated launch');
	};
});

test('browser lane proves shared native alias, atomic updates, growth and copied-buffer control', async () => {
	const module = new WebAssembly.Module(
		await readFile(new URL('../../build/sharing.wasm', import.meta.url))
	);
	const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
	const replies: any[] = [];
	const context: any = vm.createContext({
		crypto,
		WebAssembly,
		SharedArrayBuffer,
		Uint8Array,
		Uint32Array,
		performance,
		self: { postMessage: (value: unknown) => replies.push(value) }
	});
	vm.runInContext(`(${browserLane.toString()})();`, context);
	let sequence = 0;
	const request = (message: Record<string, unknown>) => {
		context.self.onmessage({ data: { ...structuredClone(message), sequence: ++sequence } });
		const reply = replies.pop();
		assert.equal(reply.sequence, sequence);
		assert.equal(reply.error, undefined);
		return reply.result;
	};
	const words = new Uint32Array(memory.buffer);
	words[32] = 20;
	assert.equal(request({ action: 'attach', memory, module }).shared, true);
	assert.deepEqual(
		request({ action: 'mutate', address: 128, jsAddress: 256, value: 100 }).before,
		20
	);
	assert.equal(words[0], 10000);
	assert.equal(words[32], 100);
	assert.equal(words[64], 1100);
	assert.equal(request({ action: 'read', address: 128 }).value, 100);
	const copied = new Uint32Array(16384);
	copied[0] = 91;
	assert.equal(request({ action: 'copy', buffer: copied.buffer, value: 200 }).after, 200);
	assert.equal(copied[0], 91);
	assert.equal(request({ action: 'copy-read' }).value, 200);
	const oldLength = memory.buffer.byteLength;
	memory.grow(1);
	const growth = request({ action: 'growth', address: oldLength });
	assert.equal(growth.zero, true);
	assert.equal(growth.oldLength, oldLength);
	assert.equal(growth.newLength, oldLength + 65536);
	request({ action: 'write', address: oldLength, value: 700 });
	assert.equal(new Uint32Array(memory.buffer)[oldLength / 4], 700);
	const created = request({ action: 'create' });
	assert.equal(new Uint32Array(created.memory.buffer)[0], 47);
	context.self.onmessage({ data: { action: 'unknown', sequence: ++sequence } });
	assert.match(replies.pop().error, /Unknown browser lane action/);
});

test('browser worker source remains standalone after removing module exports', () => {
	const context: any = vm.createContext({});
	vm.runInContext(transpileProbe().replace(/^export /gm, ''), context);
	assert.equal(typeof context.browserLane, 'function');
	assert.equal(typeof context.runBrowserProbe, 'function');
});

test('browser entry protects launches and serves cross-origin-isolated assets', async () => {
	let calls = 0;
	const env: any = {
		PROBE_TOKEN: 'test-only-token',
		GATE: {
			idFromName: () => 'gate',
			get: () => ({
				fetch: async () => {
					calls++;
					return new Response('accepted');
				}
			})
		}
	};
	const authorization = { authorization: 'Bearer test-only-token' };
	const handle = (path: string, init?: RequestInit) =>
		entry.fetch(new Request(`https://probe.test${path}`, init), env);
	assert.equal((await handle('/run', { method: 'POST' })).status, 401);
	assert.equal((await handle('/run', { headers: authorization })).status, 405);
	assert.equal(calls, 0);
	assert.equal((await handle('/run', { method: 'POST', headers: authorization })).status, 200);
	assert.equal(calls, 1);
	for (const path of ['/arena', '/probe.js', '/lane.js', '/sharing.wasm', '/fixture.wasm']) {
		const response = await handle(path);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
		assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
		assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
	}
	assert.match(await (await handle('/lane.js')).text(), /browserLane\(\);$/);
	assert.equal((await handle('/missing')).status, 404);
	assert.equal((await handle('/arena', { method: 'POST' })).status, 405);
});

test('browser gate enforces one live run and two total launches and closes each launched browser', async () => {
	let launches = 0;
	let closes = 0;
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	launcher.launch = async () => {
		launches++;
		await wait;
		return {
			newPage: async () => ({
				setDefaultTimeout() {},
				goto: async () => {},
				evaluate: async () => ({ passed: true })
			}),
			close: async () => {
				closes++;
			}
		};
	};
	const storage = new Map<string, unknown>();
	const gate = new BrowserGate(
		{
			storage: {
				get: async (key: string) => storage.get(key),
				put: async (key: string, value: unknown) => void storage.set(key, value)
			}
		} as never,
		{ BROWSER: {} } as never
	);
	const request = () =>
		new Request('https://gate/run', {
			method: 'POST',
			body: JSON.stringify({ origin: 'https://probe.test' })
		});
	const first = gate.fetch(request());
	assert.equal((await gate.fetch(request())).status, 409);
	release();
	assert.equal((await first).status, 200);
	assert.equal((await gate.fetch(request())).status, 200);
	assert.equal((await gate.fetch(request())).status, 429);
	assert.equal(launches, 2);
	assert.equal(closes, 2);
	assert.equal(gate.busy, false);
});
