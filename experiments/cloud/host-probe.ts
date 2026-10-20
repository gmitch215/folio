import binaryen from 'binaryen';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { FolioHost } from '../../src/host.ts';
import { decodeBytes } from '../../src/remote.ts';

const workerModule = `
import { RemoteFolio, encodeBytes } from './remote.mjs';
export default {
	async fetch(request, env) {
		const { count, rounds, authorization } = await request.json();
		const options = { workers: 4, headers: { authorization },
			fetch: request => env.FOLIO.fetch(request) };
		const remote = await RemoteFolio.open('https://execution.test/folio', 'fixture', options);
		let result;
		try {
			const input = Uint32Array.from({ length: count }, (_, i) => (Math.imul(i, 2654435761) + 1) >>> 0);
			await remote.write(1024, new Uint8Array(input.buffer));
			const report = await remote.run('program', [1024, count, rounds]);
			result = { report: { mode: report.mode, workers: report.workers, regions: report.regions,
				replayed: report.replayed, fallbacks: report.fallbacks,
				voidResultExact: report.values.length === 1 && report.values[0] === undefined },
				threadIds: remote.info.threadIds,
				capabilities: remote.info.capabilities,
				output: encodeBytes(await remote.read(0, 131072)) };
		} finally { await remote.close(); }
		const numeric = await RemoteFolio.open('https://execution.test/folio', 'abi', options);
		try {
			const value = -9223372036854775807n;
			const report = await numeric.run('echo', [value]);
			result.bigintExact = report.values[0] === value;
		} finally { await numeric.close(); }
		return Response.json(result);
	}
};`;

// no deployment: the portable client runs in stock workerd and reaches a real Node execution host
export async function runHostProbe(output?: string) {
	const source = await readFile(new URL('../../build/fixture.wasm', import.meta.url));
	const remoteSource = await readFile(new URL('../../src/remote.ts', import.meta.url), 'utf8');
	const remoteModule = ts.transpileModule(remoteSource, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
	}).outputText;
	assert.equal(/\bfrom\s+['"]node:/.test(remoteModule), false);
	assert.equal(
		/WebAssembly\.(compile|instantiate)|new WebAssembly\.(Module|Instance)/.test(remoteModule),
		false
	);
	const abi = binaryen.parseText(
		'(module (func (export "echo") (param i64) (result i64) (local.get 0)))'
	);
	const abiBytes = abi.emitBinary();
	abi.dispose();
	let createdGroups = 0;
	let disposedGroups = 0;
	let hostRequests = 0;
	const authorization = `Bearer local-probe-${crypto.randomUUID()}`;
	const host = new FolioHost({
		authorize: (request) => request.headers.get('authorization') === authorization,
		limits: { liveGroups: 1, workersPerGroup: 4, memoryBytesPerGroup: 131072 },
		artifacts: {
			fixture: {
				program: source,
				exports: ['program'],
				create: () => {
					createdGroups++;
					return {
						options: {
							memory: new WebAssembly.Memory({
								initial: 2,
								maximum: 8192,
								shared: true
							})
						},
						dispose: () => {
							disposedGroups++;
						}
					};
				}
			},
			abi: {
				program: abiBytes,
				exports: ['echo'],
				create: () => {
					createdGroups++;
					return {
						dispose: () => {
							disposedGroups++;
						}
					};
				}
			}
		}
	});
	const root = fileURLToPath(new URL('./', import.meta.url));
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			modulesRoot: root,
			modules: [
				{ type: 'ESModule', path: `${root}host-probe-worker.mjs`, contents: workerModule },
				{ type: 'ESModule', path: `${root}remote.mjs`, contents: remoteModule }
			],
			compatibilityDate: '2026-08-22',
			serviceBindings: {
				FOLIO: (request: Request) => {
					hostRequests++;
					return host.fetch(request);
				}
			}
		})
	);
	const count = 4097;
	const rounds = 64;
	const began = performance.now();
	let result: Record<string, any>;
	try {
		const response = await mf.dispatchFetch('https://edge.test/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ count, rounds, authorization })
		});
		assert.equal(response.status, 200, await response.clone().text());
		const raw: any = await response.json();
		const reference = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
		new Uint32Array(reference.buffer, 1024, count).set(
			Uint32Array.from({ length: count }, (_, i) => (Math.imul(i, 2654435761) + 1) >>> 0)
		);
		const native = new WebAssembly.Instance(new WebAssembly.Module(source), {
			env: { memory: reference }
		});
		(native.exports.program as CallableFunction)(1024, count, rounds);
		assert.deepEqual(decodeBytes(raw.output), new Uint8Array(reference.buffer));
		assert.equal(raw.report.mode, 'native-shared');
		assert.equal(raw.report.workers, 4);
		assert.equal(raw.report.voidResultExact, true);
		assert.equal(new Set(raw.threadIds).size, 4);
		assert.equal(raw.bigintExact, true);
		assert.equal(host.activeGroups, 0);
		assert.equal(createdGroups, disposedGroups);
		const require = createRequire(import.meta.url);
		result = {
			collectedAt: new Date().toISOString(),
			runtime: {
				node: process.version,
				miniflare: require('miniflare/package.json').version,
				workerdPackage: require('workerd/package.json').version,
				compatibilityDate: '2026-08-22'
			},
			mechanism:
				'stock-workerd service binding -> authenticated Node execution host -> shared Folio isolates',
			boundary:
				'edge-to-host payloads are serialized; physical shared backing is within the Node execution host',
			input: { count, rounds, activeBytes: count * 4, checkedBytes: 131072 },
			assertions: {
				exactWholeMemory: true,
				bigintExact: raw.bigintExact,
				voidResultExact: raw.report.voidResultExact,
				portableClientHasNoNodeImports: true,
				portableClientDoesNotCompileWasm: true
			},
			report: raw.report,
			threadIds: raw.threadIds,
			distinctThreads: new Set(raw.threadIds).size,
			hostRequests,
			createdGroups,
			disposedGroups,
			wallMs: performance.now() - began
		};
	} finally {
		await mf.dispose();
		await host.close();
	}
	result.cleanup = { activeGroups: host.activeGroups, joined: true, miniflareDisposed: true };
	if (output) await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
	return result;
}

if (import.meta.main) console.log(JSON.stringify(await runHostProbe(process.argv[2]), null, 2));
