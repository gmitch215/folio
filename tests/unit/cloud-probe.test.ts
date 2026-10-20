import assert from 'node:assert/strict';
import { test } from 'vitest';
import { collect, summarize } from '../../experiments/cloud/run.ts';

function fixture(): Record<string, any> {
	return {
		capabilities: {
			isolateId: 'caller',
			cloneSab: { ok: true, value: { forwardVisible: true, reverseVisible: true } },
			localChannelSab: { ok: false },
			bundledWasmAtomics: { ok: true, value: { valid: true } }
		},
		rpc: {
			distinctIsolates: true,
			bytes: {
				ok: true,
				value: {
					remoteBefore: 17,
					remoteAfter: 29,
					echoedAfter: 29,
					callerUnaffected: true
				}
			},
			...Object.fromEntries(
				[
					'sab',
					'sharedMemory',
					'ordinaryMemory',
					'returnSab',
					'returnSharedMemory',
					'rpcMessagePort'
				].map((name) => [name, { ok: false }])
			)
		}
	};
}

test('keeps local aliasing separate from cross-isolate sharing', () => {
	const result = summarize(fixture());
	assert.equal(result.localSabCloneAlias, true);
	assert.equal(result.localChannelSabAlias, false);
	assert.equal(result.sharedRpc.sab.ok, false);
	assert.equal(result.rpcDistinctIsolates, true);
});

test('rejects a failed ordinary byte control', () => {
	const raw = fixture();
	raw.rpc.bytes.value.echoedAfter = 17;
	assert.throws(() => summarize(raw), assert.AssertionError);
});

test('collects only the requested bounded routes', async () => {
	const raw = fixture();
	const paths: string[] = [];
	const result = await collect('https://folio.test', {
		cpu: false,
		nonce: 'fixture',
		fetch: async (url) => {
			paths.push(url.pathname);
			return Response.json(url.pathname === '/rpc' ? raw.rpc : raw.capabilities);
		}
	});
	assert.deepEqual(paths, ['/capabilities', '/rpc']);
	assert.equal(result.raw.cpu, undefined);
	assert.equal(result.summary.ordinaryByteRpcExact, true);
});

test('reports a rejected endpoint before making more requests', async () => {
	let requests = 0;
	await assert.rejects(
		collect('https://folio.test', {
			fetch: async () => {
				requests++;
				return Response.json({ error: 'probe rejected' }, { status: 400 });
			}
		}),
		/probe rejected/
	);
	assert.equal(requests, 1);
});

test('summarizes the CPU matrix with paired speedups and co-resident objects', async () => {
	const base = fixture();
	const count = 1024;
	const rows = [0, 1, 2].flatMap((round) =>
		[1, 2, 4, 8].map((lanes) => ({
			lanes,
			round,
			phase: round ? 'measure' : 'warmup',
			wallMs: 8 / lanes + round,
			checksum: 7,
			exact: true,
			distinctIsolates: 1,
			parts: Array.from({ length: lanes }, (_, i) => {
				const start = Math.floor((count * i) / lanes);
				return {
					isolateId: 'shared-isolate',
					objectId: `object-${i}`,
					start,
					count: Math.floor((count * (i + 1)) / lanes) - start
				};
			})
		}))
	);
	const summary = summarize({
		...base,
		cpu: { laneInvocations: 45, rows, exact: true, expected: 7, count }
	});
	assert.equal(summary.cpu.length, 4);
	assert.equal(summary.cpu[0].pairedSpeedups[0], 1);
	assert.equal(summary.coResidentObjects[0].objectIds.length, 8);
});
