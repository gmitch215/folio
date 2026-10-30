import { Folio } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

// A loop that calls one function per record has no plan of its own. With a shared memory, Folio runs
// the iterations on workers, checks them in order and replays any that conflict. The report shows
// which route ran and why a loop stayed serial.
const bytes = readFileSync(new URL('../build/records.wasm', import.meta.url));
const records = 32;
const size = 1 << 20;
const table = 1024;
const out = 2048;
const data = 1 << 20;
const memory = new WebAssembly.Memory({
	initial: 1 + ((data + records * size) >> 16),
	maximum: 8192,
	shared: true
});

const place = () => {
	const view = new Uint32Array(memory.buffer, table, 2 * records);
	for (let i = 0; i < records; i++) {
		view[2 * i] = data + i * size;
		view[2 * i + 1] = size;
	}
	new Uint8Array(memory.buffer, out, 32 * records).fill(0);
};
const digests = () => Buffer.from(new Uint8Array(memory.buffer, out, 32 * records)).toString('hex');

const folio = await Folio.open(bytes, { memory, workers: 4 });
try {
	for (let i = 0; i < records * size; i += 4099) new Uint8Array(memory.buffer)[data + i] = i;

	place();
	let started = performance.now();
	const serial = await folio.run('digest_all', [table, records, out], { parallel: 'off' });
	const serialMs = performance.now() - started;
	const expected = digests();

	// the first call also warms the workers, so time the second
	place();
	await folio.run('digest_all', [table, records, out]);
	place();
	started = performance.now();
	const report = await folio.run('digest_all', [table, records, out]);
	const parallelMs = performance.now() - started;

	console.log('serial', { mode: serial.mode, reason: serial.reason, ms: Math.round(serialMs) });
	console.log('auto', {
		mode: report.mode,
		extraction: report.extraction,
		reason: report.reason,
		workers: report.workers,
		dispatched: report.iteration?.regions,
		replayed: report.iteration?.replayed,
		stopped: report.iteration?.stopped,
		ms: Math.round(parallelMs)
	});
	console.log('same digests', digests() === expected);
} finally {
	await folio.close();
}
