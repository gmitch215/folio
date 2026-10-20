import { Folio, prepare } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const program = prepare(readFileSync(new URL('../build/fixture.wasm', import.meta.url)));
const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
new Uint32Array(memory.buffer, 1024, 37).fill(1);

const folio = await Folio.open(program, { memory, workers: 4 });
try {
	const report = await folio.run('program', [1024, 37, 10000]);
	console.log(report);
	console.log(new Uint32Array(folio.memory.buffer, 1024, 4));
} finally {
	await folio.close();
}
