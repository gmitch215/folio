import { Folio, prepare } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

// Small regions cost more to dispatch than to run, so default admission keeps them serial.
// Check the report before assuming a call ran in parallel.
const program = prepare(readFileSync(new URL('../build/fixture.wasm', import.meta.url)));
const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
const folio = await Folio.open(program, { memory, workers: 4, adaptiveRouting: true });

const show = (label: string, report: Awaited<ReturnType<Folio['run']>>) =>
	console.log(label, { mode: report.mode, workers: report.workers, reason: report.reason });

try {
	new Uint32Array(memory.buffer, 1024, 64).fill(1);
	show('small work', await folio.run('program', [1024, 64, 4]));
	show('large work', await folio.run('program', [1024, 64, 1_000_000]));
	// leave CPU for other jobs by capping the workers of one run
	show('capped', await folio.run('program', [1024, 64, 1_000_000], { maximumWorkers: 2 }));
	// calls that depend on each other replay; with adaptiveRouting a repeated shape runs natively
	for (let call = 0; call < 5; call++)
		show(`dependent ${call}`, await folio.run('dependent_program', [1024, 64]));
} finally {
	await folio.close();
}
