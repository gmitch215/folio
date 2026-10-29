import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Consumer } from '../../probe/consumer.ts';
import { corpusImports, corpusManifest, resetCorpus } from '../corpus.ts';

export function corpusConsumer(id: string): Consumer {
	const kernel = corpusManifest.cases.find((item) => item.id === id);
	if (!kernel) throw new Error(`unknown corpus case: ${id}`);
	const artifact = fileURLToPath(
		new URL(`../../../build/research/corpus/artifacts/${id}.wasm`, import.meta.url)
	);
	const initial = new WeakMap<WebAssembly.Memory, Uint8Array>();
	return {
		name: id,
		bytes: new Uint8Array(readFileSync(artifact)),
		imports: corpusImports,
		cases: [
			{
				name: 'upstream-entry',
				prepare(api) {
					let snapshot = initial.get(api.memory);
					if (!snapshot) {
						snapshot = new Uint8Array(api.memory.buffer).slice();
						initial.set(api.memory, snapshot);
					}
					resetCorpus(api.exports, api.memory, snapshot);
					return [{ export: 'entry', args: [] }];
				}
			}
		]
	};
}

const id = process.env.FOLIO_CORPUS_CASE;
export default id ? corpusConsumer(id) : undefined;
