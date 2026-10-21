import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { FolioHost } from '../../src/host.ts';
import { suspending } from '../../src/node.ts';
import {
	RemoteError,
	RemoteFolio,
	UncertainDelivery,
	decodeValue,
	encodeValue
} from '../../src/remote.ts';

const fixture = readFileSync(new URL('../../build/fixture.wasm', import.meta.url));
const headers = { authorization: 'Bearer test-only-credential' };
function host(extra: ConstructorParameters<typeof FolioHost>[0]['limits'] = {}) {
	return new FolioHost({
		authorize: (request) => request.headers.get('authorization') === headers.authorization,
		artifacts: {
			fixture: {
				program: fixture,
				exports: ['program', 'increment', 'trap_after_write'],
				create: () => ({
					options: {
						memory: new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true })
					}
				})
			}
		},
		limits: extra
	});
}
async function request(server: FolioHost, path: string, value: unknown) {
	const response = await server.fetch(
		new Request(`https://folio.test${path}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(encodeValue(value))
		})
	);
	return { status: response.status, value: decodeValue(await response.json()) };
}

test('portable transport preserves exact numeric bits, BigInts and collision-shaped records', () => {
	const view = new DataView(new ArrayBuffer(8));
	view.setBigUint64(0, 0xfff8123456789abcn);
	const value = [
		undefined,
		-0,
		Infinity,
		-Infinity,
		view.getFloat64(0),
		-123456789012345678901234567890n,
		{ __folio_type: 'number', nested: [true, null] }
	];
	const result = decodeValue(JSON.parse(JSON.stringify(encodeValue(value))));
	assert.deepEqual(result, value);
	view.setFloat64(0, result[4] as number);
	assert.equal(view.getBigUint64(0), 0xfff8123456789abcn);
	assert.equal(Object.is(result[1], -0), true);
	assert.throws(() => encodeValue(() => {}), TypeError);
	assert.throws(
		() =>
			decodeValue([
				'o',
				[
					['x', ['u']],
					['x', ['u']]
				]
			]),
		/invalid/
	);
	const prototypeKey = decodeValue(['o', [['__proto__', ['v', 'data']]]]);
	assert.equal(Object.getPrototypeOf(prototypeKey), Object.prototype);
	assert.equal(Object.hasOwn(prototypeKey, '__proto__'), true);
});

test('real Folio host runs an unannotated C entry across shared isolates and returns exact bytes', async () => {
	const server = host();
	let remote: RemoteFolio | undefined;
	try {
		remote = await RemoteFolio.open('https://folio.test/folio', 'fixture', {
			headers,
			fetch: server.fetch,
			workers: 4
		});
		assert.equal(new Set(remote.info.threadIds).size, 4);
		const input = Uint32Array.from({ length: 127 }, (_, i) => i + 1);
		const reference = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
		new Uint8Array(reference.buffer, 1024, input.byteLength).set(new Uint8Array(input.buffer));
		const native = new WebAssembly.Instance(new WebAssembly.Module(fixture), {
			env: { memory: reference }
		});
		(native.exports.program as CallableFunction)(1024, input.length, 10000);
		await remote.write(1024, new Uint8Array(input.buffer));
		const report = await remote.run('program', [1024, input.length, 10000]);
		assert.equal(report.mode, 'native-shared');
		assert.equal(report.workers, 4);
		assert.deepEqual(await remote.read(0, 131072), new Uint8Array(reference.buffer));
		await assert.rejects(
			remote.run('mix', [1024, 1]),
			(error: unknown) => error instanceof RemoteError && error.status === 403
		);
		await assert.rejects(
			remote.run('trap_after_write', [1024]),
			(error: unknown) => error instanceof RemoteError && error.kind === 'RuntimeError'
		);
		assert.equal(new DataView((await remote.read(1024, 4)).buffer).getUint32(0, true), 91);
	} finally {
		await remote?.close();
		await server.close();
	}
	assert.equal(server.activeGroups, 0);
});

test('authorization, artifact allowlists, byte and live group limits are enforced', async () => {
	const server = host({ liveGroups: 1, readBytes: 4, writeBytes: 4, requestBytes: 2048 });
	let remote: RemoteFolio | undefined;
	try {
		assert.equal((await server.fetch(new Request('https://folio.test/folio'))).status, 401);
		await assert.rejects(
			RemoteFolio.open('https://folio.test/folio', 'unregistered', {
				fetch: server.fetch,
				headers
			}),
			(error: unknown) => error instanceof RemoteError && error.status === 404
		);
		remote = await RemoteFolio.open('https://folio.test/folio', 'fixture', {
			fetch: server.fetch,
			headers,
			workers: 2
		});
		await assert.rejects(
			RemoteFolio.open('https://folio.test/folio', 'fixture', {
				fetch: server.fetch,
				headers
			}),
			(error: unknown) => error instanceof RemoteError && error.status === 429
		);
		await assert.rejects(remote.read(0, 5), /admission/);
		await assert.rejects(remote.write(0, new Uint8Array(5)), /byte limit/);
		await assert.rejects(remote.read(131072, 1), /out of bounds/);
		const oversized = await server.fetch(
			new Request('https://folio.test/folio', {
				method: 'POST',
				headers,
				body: 'x'.repeat(2049)
			})
		);
		assert.equal(oversized.status, 413);
		await remote.write(0, new Uint8Array([1, 2, 3, 4]));
		assert.deepEqual(await remote.read(0, 4), new Uint8Array([1, 2, 3, 4]));
	} finally {
		await remote?.close();
		await server.close();
	}
});

test('admission counts a hidden owned arena exposed by the coordinator', async () => {
	const module = binaryen.parseText(`(module (memory 2 2)
		(func $put (param i32) (i32.store (local.get 0) (i32.const 7)))
		(func (export "main") (call $put (i32.const 0)) (call $put (i32.const 4))))`);
	const program = module.emitBinary();
	module.dispose();
	const server = new FolioHost({
		authorize: () => true,
		limits: { memoryBytesPerGroup: 65536 },
		artifacts: {
			hidden: {
				program,
				exports: ['main'],
				create: () => ({ options: { minimumRegionWork: 0 } })
			}
		}
	});
	try {
		await assert.rejects(
			RemoteFolio.open('https://folio.test/folio', 'hidden', {
				fetch: server.fetch,
				workers: 2
			}),
			(error: unknown) => error instanceof RemoteError && error.status === 413
		);
		assert.equal(server.activeGroups, 0);
	} finally {
		await server.close();
	}
});

test('a lost response recovers the cached result and never repeats the effect', async () => {
	const server = host();
	let loseResponse = false;
	let remote: RemoteFolio | undefined;
	try {
		remote = await RemoteFolio.open('https://folio.test/folio', 'fixture', {
			headers,
			workers: 2,
			fetch: async (request) => {
				const response = await server.fetch(request);
				if (loseResponse) {
					loseResponse = false;
					throw new Error('simulated disconnected response');
				}
				return response;
			}
		});
		loseResponse = true;
		await assert.rejects(remote.run('increment', [1024]), UncertainDelivery);
		await assert.rejects(remote.read(1024, 4), /uncertain request/);
		assert.deepEqual((await remote.retryPending()).values, [1]);
		assert.equal(new DataView((await remote.read(1024, 4)).buffer).getUint32(0, true), 1);
	} finally {
		await remote?.close();
		await server.close();
	}
});

test('a lost trap response retains prior writes without executing the trap twice', async () => {
	const server = host();
	let loseResponse = false;
	let remote: RemoteFolio | undefined;
	try {
		remote = await RemoteFolio.open('https://folio.test/folio', 'fixture', {
			headers,
			workers: 2,
			fetch: async (request) => {
				const response = await server.fetch(request);
				if (loseResponse) {
					loseResponse = false;
					throw new Error('lost trap');
				}
				return response;
			}
		});
		loseResponse = true;
		await assert.rejects(remote.run('trap_after_write', [1024]), UncertainDelivery);
		await assert.rejects(
			remote.retryPending(),
			(error: unknown) => error instanceof RemoteError && error.kind === 'RuntimeError'
		);
		assert.equal(new DataView((await remote.read(1024, 4)).buffer).getUint32(0, true), 91);
	} finally {
		await remote?.close();
		await server.close();
	}
});

test('an authorization refusal does not consume the session operation number', async () => {
	const server = host();
	let refuse = false;
	let remote: RemoteFolio | undefined;
	try {
		remote = await RemoteFolio.open('https://folio.test/folio', 'fixture', {
			headers,
			workers: 2,
			fetch: (request) => {
				if (!refuse) return server.fetch(request);
				refuse = false;
				const unauthorized = new Request(request);
				unauthorized.headers.delete('authorization');
				return server.fetch(unauthorized);
			}
		});
		refuse = true;
		await assert.rejects(
			remote.run('increment', [1024]),
			(error: unknown) => error instanceof RemoteError && error.status === 401
		);
		assert.deepEqual((await remote.run('increment', [1024])).values, [1]);
	} finally {
		await remote?.close();
		await server.close();
	}
});

test('session sequencing prevents conflicting duplicates, gaps and cross-session access', async () => {
	const server = host();
	try {
		const opened = await request(server, '/folio', { artifact: 'fixture', workers: 2 });
		const path = `/folio/${opened.value.capability}`;
		const command = { sequence: 0, operation: 'run', entry: 'increment', args: [1024] };
		const [a, b] = await Promise.all([
			request(server, path, command),
			request(server, path, command)
		]);
		assert.deepEqual(a, b);
		assert.deepEqual(a.value.values, [1]);
		assert.equal((await request(server, path, { ...command, args: [1028] })).status, 409);
		assert.equal((await request(server, path, { ...command, sequence: 8 })).status, 409);
		assert.equal((await request(server, '/folio/not-a-capability', command)).status, 404);
		assert.equal(
			(await request(server, path, { sequence: 1, operation: 'close' })).status,
			200
		);
		assert.equal(
			(await request(server, path, { sequence: 1, operation: 'close' })).status,
			200
		);
	} finally {
		await server.close();
	}
});

test('async imported effects remain ordered, and host cleanup joins them before disposal', async () => {
	const module = binaryen.parseText(
		'(module (import "host" "effect" (func $effect (param i64) (result i64))) (func (export "main") (param i64) (result i64) (call $effect (local.get 0))))'
	);
	const bytes = module.emitBinary();
	module.dispose();
	const events: string[] = [];
	let release!: () => void;
	let started!: () => void;
	const starting = new Promise<void>((resolve) => {
		started = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server = new FolioHost({
		authorize: () => true,
		artifacts: {
			async: {
				program: bytes,
				exports: ['main'],
				create: () => ({
					options: {
						promising: ['main'],
						imports: {
							host: {
								effect: suspending(async (value: bigint) => {
									events.push('effect-start');
									started();
									await gate;
									events.push('effect-end');
									return value + 1n;
								})
							}
						}
					},
					dispose: () => {
						events.push('dispose');
					}
				})
			}
		}
	});
	const remote = await RemoteFolio.open('https://folio.test/folio', 'async', {
		fetch: server.fetch
	});
	try {
		const running = remote.run('main', [9007199254740993n]);
		await starting;
		const closing = server.close();
		assert.deepEqual(events, ['effect-start']);
		release();
		assert.deepEqual((await running).values, [9007199254740994n]);
		await closing;
		assert.deepEqual(events, ['effect-start', 'effect-end', 'dispose']);
	} finally {
		release();
		await server.close();
	}
});

test('an oversized effect response is bounded and cached after exactly one execution', async () => {
	const module = binaryen.parseText(
		'(module (import "host" "effect" (func $effect (result externref))) (func (export "main") (result externref) (call $effect)))'
	);
	const bytes = module.emitBinary();
	module.dispose();
	let effects = 0;
	let loseResponse = false;
	const server = new FolioHost({
		authorize: () => true,
		limits: { responseBytes: 512 },
		artifacts: {
			effect: {
				program: bytes,
				exports: ['main'],
				create: () => ({
					options: {
						imports: {
							host: {
								effect: () => {
									effects++;
									return 'x'.repeat(4096);
								}
							}
						}
					}
				})
			}
		}
	});
	const remote = await RemoteFolio.open('https://folio.test/folio', 'effect', {
		fetch: async (request) => {
			const response = await server.fetch(request);
			if (loseResponse) {
				loseResponse = false;
				throw new Error('lost oversized result');
			}
			return response;
		}
	});
	try {
		loseResponse = true;
		await assert.rejects(remote.run('main'), UncertainDelivery);
		await assert.rejects(
			remote.retryPending(),
			(error: unknown) => error instanceof RemoteError && error.status === 413
		);
		assert.equal(effects, 1);
	} finally {
		await remote.close();
		await server.close();
	}
});

test('host close joins an admitted opening group and disposes bindings exactly once', async () => {
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let disposals = 0;
	const server = new FolioHost({
		authorize: () => true,
		artifacts: {
			fixture: {
				program: fixture,
				exports: ['program'],
				create: async () => {
					entered();
					await gate;
					return {
						options: {
							memory: new WebAssembly.Memory({
								initial: 2,
								maximum: 8192,
								shared: true
							})
						},
						dispose: () => {
							disposals++;
						}
					};
				}
			}
		}
	});
	const opening = RemoteFolio.open('https://folio.test/folio', 'fixture', {
		fetch: server.fetch,
		workers: 2
	});
	const rejected = assert.rejects(
		opening,
		(error: unknown) => error instanceof RemoteError && error.status === 503
	);
	await started;
	const closing = server.close();
	release();
	await rejected;
	await closing;
	assert.equal(disposals, 1);
	assert.equal(server.activeGroups, 0);
});

test('an admission slot remains occupied until the binding disposer has joined', async () => {
	let release!: () => void;
	let entered!: () => void;
	const disposing = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server = new FolioHost({
		authorize: () => true,
		limits: { liveGroups: 1 },
		artifacts: {
			fixture: {
				program: fixture,
				exports: [],
				create: () => ({
					options: {
						memory: new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true })
					},
					dispose: async () => {
						entered();
						await gate;
					}
				})
			}
		}
	});
	const remote = await RemoteFolio.open('https://folio.test/folio', 'fixture', {
		fetch: server.fetch,
		workers: 2
	});
	try {
		const closing = remote.close();
		await disposing;
		assert.equal(server.activeGroups, 1);
		await assert.rejects(
			RemoteFolio.open('https://folio.test/folio', 'fixture', { fetch: server.fetch }),
			(error: unknown) => error instanceof RemoteError && error.status === 429
		);
		release();
		await closing;
		assert.equal(server.activeGroups, 0);
	} finally {
		release();
		await server.close();
	}
});

test('an abandoned session expires and joins resource disposal', async () => {
	let disposed!: () => void;
	const disposing = new Promise<void>((resolve) => {
		disposed = resolve;
	});
	const server = new FolioHost({
		authorize: () => true,
		limits: { idleMilliseconds: 10 },
		artifacts: {
			fixture: {
				program: fixture,
				exports: [],
				create: () => ({
					options: {
						memory: new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true })
					},
					dispose: () => {
						disposed();
					}
				})
			}
		}
	});
	try {
		await RemoteFolio.open('https://folio.test/folio', 'fixture', {
			fetch: server.fetch,
			workers: 2
		});
		await disposing;
		await server.close();
		assert.equal(server.activeGroups, 0);
	} finally {
		await server.close();
	}
});

test('active async operations refresh the idle lifetime when they complete', async () => {
	const module = binaryen.parseText(`(module
		(import "host" "wait" (func $wait (result i32)))
		(memory (export "memory") 1 1)
		(func (export "main") (result i32)
			(i32.store (i32.const 0) (call $wait)) (i32.load (i32.const 0))))`);
	const program = module.emitBinary();
	module.dispose();
	let release!: () => void, entered!: () => void, disposed!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const disposing = new Promise<void>((resolve) => {
		disposed = resolve;
	});
	let disposals = 0;
	const server = new FolioHost({
		authorize: () => true,
		limits: { idleMilliseconds: 20 },
		artifacts: {
			async: {
				program,
				exports: ['main'],
				create: () => ({
					options: {
						promising: ['main'],
						imports: {
							host: {
								wait: suspending(async () => {
									entered();
									await gate;
									return 7;
								})
							}
						}
					},
					dispose: () => {
						disposals++;
						disposed();
					}
				})
			}
		}
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const remote = await RemoteFolio.open('https://folio.test/folio', 'async', {
			fetch: server.fetch,
			workers: 1
		});
		const running = remote.run('main');
		await started;
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(disposals, 0);
		release();
		assert.deepEqual((await running).values, [7]);
		assert.deepEqual(await remote.read(0, 4), new Uint8Array([7, 0, 0, 0]));
		assert.equal(server.activeGroups, 1);
		assert.equal(disposals, 0);
		await Promise.race([
			disposing,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('idle session did not expire')), 1000);
			})
		]);
		await server.close();
		assert.equal(server.activeGroups, 0);
		assert.equal(disposals, 1);
	} finally {
		clearTimeout(timer);
		release();
		await server.close();
	}
});
