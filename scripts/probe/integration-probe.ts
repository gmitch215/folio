import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { memoryImports } from '../../src/memory.ts';
import { Folio } from '../../src/node.ts';

const [tinyPath, corePath] = process.argv.slice(2);
if (!tinyPath || !corePath)
	throw new Error('Usage: node scripts/integration-probe.ts TINYIMG.wasm MACHINE-CORE.wasm');
const results: unknown[] = [];
{
	const bytes = readFileSync(tinyPath),
		module = new WebAssembly.Module(bytes);
	const reference = new WebAssembly.Instance(module);
	const folio = await Folio.open(bytes);
	const expectedMemory = reference.exports.memory as WebAssembly.Memory;
	let calls = 0;
	const executions: { entry: string; mode: string; regions: number; workers: number }[] = [];
	const call = async (name: string, args: number[] = []) => {
		const expected = (reference.exports[name] as CallableFunction)(...args);
		const report = await folio.run(name, args);
		executions.push({
			entry: name,
			mode: report.mode,
			regions: report.regions,
			workers: report.workers
		});
		assert.deepEqual(report.values, [expected]);
		assert.deepEqual(
			new Uint8Array(folio.memory.buffer),
			new Uint8Array(expectedMemory.buffer)
		);
		calls++;
		return expected as number;
	};
	try {
		await call('tiny_init');
		assert.equal(await call('tiny_abi_version'), 2);
		const pointer = await call('tiny_alloc', [await call('tiny_image_sizeof')]);
		assert.ok(pointer > 0);
		assert.equal(await call('tiny_image_create', [pointer, 96, 64, 4]), 0);
		const color = await call('tiny_alloc', [4]);
		for (const memory of [folio.memory, expectedMemory])
			new Uint8Array(memory.buffer, color, 4).set([0x31, 0x67, 0xaa, 0xff]);
		assert.equal(await call('tiny_image_fill_rectangle', [pointer, 0, 0, 96, 64, color]), 0);
		assert.equal(await call('tiny_image_invert', [pointer]), 0);
		assert.equal(await call('tiny_image_getwidth', [pointer]), 96);
		assert.equal(await call('tiny_image_getheight', [pointer]), 64);
		assert.equal(await call('tiny_image_getsize', [pointer]), 96 * 64 * 4);
		await call('tiny_image_destroy', [pointer]);
		await call('tiny_free', [pointer]);
		await call('tiny_free', [color]);
		results.push({
			workload: 'actual tinyimg ABI2 image create/fill/invert/destroy',
			bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			calls,
			exactWholeMemoryAfterEveryCall: true,
			executions,
			diagnostics: folio.diagnostics,
			memoryBytes: folio.memory.buffer.byteLength
		});
	} finally {
		await folio.close();
	}
}
{
	const bytes = readFileSync(corePath),
		module = new WebAssembly.Module(bytes);
	const descriptor = memoryImports(bytes)[0]!;
	const memory = () =>
		new WebAssembly.Memory({
			initial: Math.max(descriptor.initial, 2),
			maximum: descriptor.maximum ?? 8192,
			shared: descriptor.shared
		});
	const actual = memory(),
		expected = memory();
	const imports = (memory: WebAssembly.Memory): WebAssembly.Imports => ({
		env: {
			memory,
			__indirect_function_table: new WebAssembly.Table({ element: 'anyfunc', initial: 0 }),
			__memory_base: new WebAssembly.Global({ value: 'i32' }, 1024),
			__table_base: new WebAssembly.Global({ value: 'i32' }, 0),
			__stack_pointer: new WebAssembly.Global({ value: 'i32', mutable: true }, 65536)
		}
	});
	const reference = new WebAssembly.Instance(module, imports(expected));
	const folio = await Folio.open(bytes, { imports: imports(actual) });
	const calls = [
		{ export: 'core_version', args: [] },
		{ export: 'core_reset', args: [] },
		{ export: 'core_ready_push', args: [11] },
		{ export: 'core_ready_push', args: [22] },
		{ export: 'core_ready_unshift', args: [33] },
		{ export: 'core_ready_count', args: [] },
		...Array.from({ length: 4 }, () => ({ export: 'core_ready_shift', args: [] }))
	];
	try {
		const values = [];
		for (const call of calls)
			values.push((reference.exports[call.export] as CallableFunction)(...call.args));
		const report = await folio.runAll(calls);
		assert.deepEqual(report.values, values);
		assert.deepEqual(values.slice(-4), [33, 11, 22, -1]);
		assert.deepEqual(new Uint8Array(actual.buffer), new Uint8Array(expected.buffer));
		results.push({
			workload: 'machine core ABI1 queue and imported globals/table',
			bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			calls: calls.length,
			exactWholeMemoryAndReturns: true,
			mode: report.mode,
			diagnostics: folio.diagnostics
		});
	} finally {
		await folio.close();
	}
}
console.log(JSON.stringify({ passed: true, results }, null, 2));
