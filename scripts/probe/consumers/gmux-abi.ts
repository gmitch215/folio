import { readFileSync } from 'node:fs';
import { memoryImports } from '../../../src/memory.ts';
import type { Consumer } from '../consumer.ts';

const path =
	process.env.FOLIO_GMUX_ABI ??
	new URL('../../../../../gmux/build/probes/abi.wasm', import.meta.url).pathname;
const bytes = readFileSync(path);
const module = new WebAssembly.Module(bytes);
const descriptor = memoryImports(bytes)[0]!;
const mebibyte = 1048576;

const consumer: Consumer = {
	name: 'gmux-abi',
	bytes,
	imports() {
		const maximum = descriptor.maximum ?? 32768;
		const memory = new WebAssembly.Memory({
			initial: Math.max(descriptor.initial, Math.min(1024, maximum)),
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
						? 7 * mebibyte
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
		}
		return { imports, memory };
	},
	cases: [
		{
			name: 'memset-16mib',
			prepare: () => [{ export: 'memset', args: [8 * mebibyte, 0xa5, 16 * mebibyte] }]
		},
		{
			name: 'memcpy-16mib',
			prepare: (api) => {
				new Uint8Array(api.memory.buffer, 8 * mebibyte, 16 * mebibyte).fill(0x3c);
				return [{ export: 'memcpy', args: [28 * mebibyte, 8 * mebibyte, 16 * mebibyte] }];
			}
		},
		{
			name: 'memset-memcpy-chain',
			prepare: () => [
				{ export: 'memset', args: [8 * mebibyte, 0x11, 8 * mebibyte] },
				{ export: 'memcpy', args: [20 * mebibyte, 8 * mebibyte, 8 * mebibyte] },
				{ export: 'memset', args: [32 * mebibyte, 0x22, 8 * mebibyte] }
			]
		}
	]
};
export default consumer;
