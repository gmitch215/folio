import { readFileSync } from 'node:fs';
import { memoryImports } from '../../../src/memory.ts';
import type { Call, Consumer } from '../consumer.ts';

const path =
	process.env.FOLIO_GMUX_CORE ??
	new URL('../../../../../gmux/build/router/gmux-core.wasm', import.meta.url).pathname;
const bytes = readFileSync(path);
const descriptor = memoryImports(bytes)[0]!;

const queue = (): Call[] => [
	{ export: 'core_reset', args: [] },
	...Array.from({ length: 100 }, (_, i) => ({ export: 'core_ready_push', args: [i + 1] })),
	...Array.from({ length: 50 }, (_, i) => ({ export: 'core_ready_unshift', args: [1000 + i] })),
	{ export: 'core_ready_count', args: [] },
	...Array.from({ length: 150 }, () => ({ export: 'core_ready_shift', args: [] }))
];

const consumer: Consumer = {
	name: 'gmux-core',
	bytes,
	imports() {
		const memory = new WebAssembly.Memory({
			initial: Math.max(descriptor.initial, 2),
			maximum: descriptor.maximum ?? 8192,
			shared: descriptor.shared
		});
		return {
			memory,
			imports: {
				env: {
					memory,
					__indirect_function_table: new WebAssembly.Table({
						element: 'anyfunc',
						initial: 0
					}),
					__memory_base: new WebAssembly.Global({ value: 'i32' }, 1024),
					__table_base: new WebAssembly.Global({ value: 'i32' }, 0),
					__stack_pointer: new WebAssembly.Global({ value: 'i32', mutable: true }, 65536)
				}
			}
		};
	},
	cases: [
		{ name: 'ready-queue-batch', batch: true, prepare: queue },
		{ name: 'ready-queue-calls', prepare: queue }
	]
};
export default consumer;
