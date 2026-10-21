import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { prepare } from '../../src/compiler.ts';
import { memoryImports } from '../../src/memory.ts';
import { Folio } from '../../src/node.ts';

// Coverage is artifact-specific. Host imports deliberately fail if an unexpected effect executes.
const [output, ...paths] = process.argv.slice(2);
if (!output || !paths.length)
	throw new Error('usage: artifact-coverage.ts OUTPUT.json ARTIFACT.wasm...');
const rows = [];
for (const path of paths) {
	const bytes = readFileSync(path);
	const module = new WebAssembly.Module(bytes);
	const descriptors = memoryImports(bytes);
	if (descriptors.length !== 1) throw new Error('probe requires one imported memory');
	const descriptor = descriptors[0]!;
	const maximum = descriptor.maximum ?? 32768;
	const make = () => {
		const memory = new WebAssembly.Memory({
			initial: Math.max(descriptor.initial, Math.min(128, maximum)),
			maximum,
			shared: descriptor.shared
		});
		const imports: WebAssembly.Imports = {};
		for (const item of WebAssembly.Module.imports(module)) {
			const ns = (imports[item.module] ??= {});
			if (item.kind === 'memory') ns[item.name] = memory;
			else if (item.kind === 'table')
				ns[item.name] = new WebAssembly.Table({ initial: 4096, element: 'anyfunc' });
			else if (item.kind === 'global')
				ns[item.name] = new WebAssembly.Global(
					{
						value: 'i32',
						mutable: item.name === '__stack_pointer' || item.module === 'GOT.mem'
					},
					item.name === '__stack_pointer'
						? 7 * 1024 * 1024
						: item.name === '__memory_base'
							? 4096
							: item.name === 'kb_pending_flag'
								? 2048
								: 0
				);
			else if (item.kind === 'function')
				ns[item.name] = () => {
					throw new Error(`unprovided effect: ${item.module}.${item.name}`);
				};
			else throw new Error(`unsupported probe binding: ${item.kind}`);
		}
		return { memory, imports };
	};
	const started = performance.now();
	const prepared = prepare(bytes);
	const preparationMs = performance.now() - started;
	const actual = make(),
		expected = make();
	const reference = new WebAssembly.Instance(module, expected.imports);
	const folio = await Folio.open(prepared, { imports: actual.imports, workers: 4 });
	try {
		const coverage = Object.fromEntries(
			WebAssembly.Module.exports(module)
				.filter((item) => item.kind === 'function')
				.map((item) => [item.name, folio.inspect(item.name)])
		);
		const calls = [];
		// Execute real libc functions from a process artifact; this does not boot Linux or run main.
		if (
			typeof reference.exports.memset === 'function' &&
			typeof reference.exports.memcpy === 'function'
		) {
			for (const [name, args] of [
				['memset', [0x400000, 0xa5, 65537]],
				['memcpy', [0x500001, 0x400000, 65537]],
				['memset', [0x400001, 0x3c, 4097]]
			] as const) {
				const value = (reference.exports[name] as CallableFunction)(...args);
				const report = await folio.run(name, args);
				assert.deepEqual(report.values, [value]);
				assert.deepEqual(
					new Uint8Array(actual.memory.buffer),
					new Uint8Array(expected.memory.buffer)
				);
				calls.push({ name, args, report, exactWholeMemoryAndReturn: true });
			}
		}
		rows.push({
			artifact: basename(path),
			bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			preparationMs,
			imports: WebAssembly.Module.imports(module),
			coverage,
			diagnostics: folio.diagnostics,
			calls,
			boundary:
				'coverage and isolated process-memory functions; no kernel, process main, syscall or speedup claim'
		});
	} finally {
		await folio.close();
	}
}
writeFileSync(
	output,
	JSON.stringify({ node: process.version, v8: process.versions.v8, rows }, null, 2) + '\n'
);
console.log(
	JSON.stringify(
		rows.map((row) => ({
			artifact: row.artifact,
			exports: Object.keys(row.coverage).length,
			automatic: Object.values(row.coverage).filter((value) => value.automatic).length,
			nativeGuards: Object.values(row.coverage).filter((value) => value.nativeGuard).length,
			exactCalls: row.calls.length
		}))
	)
);
