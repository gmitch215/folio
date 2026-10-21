import { readFileSync } from 'node:fs';
import type { Consumer } from '../consumer.ts';

// the synthetic kernel behind the 7.519x record; it shows the harness can see a win and is not a consumer
const count = 64;
const consumer: Consumer = {
	name: 'kernel-control',
	bytes: readFileSync(new URL('../../../build/generalized.wasm', import.meta.url)),
	imports() {
		const memory = new WebAssembly.Memory({ initial: 2049, maximum: 8192, shared: true });
		return { memory, imports: { env: { memory } } };
	},
	cases: [
		{
			name: 'compute-64x2m',
			prepare(api) {
				const words = new Uint32Array(api.memory.buffer, 1024, count);
				for (let i = 0; i < count; i++) words[i] = Math.imul(i + 1, 2654435761) >>> 0;
				return [{ export: 'main', args: [1024, count, 2097152] }];
			}
		}
	]
};
export default consumer;
