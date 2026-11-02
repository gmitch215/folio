import { appendFileSync, writeFileSync } from 'node:fs';
import { admissionSeam } from '../../src/iteration-admission.ts';
import { Folio } from '../../src/node.ts';
import {
	clearOutput,
	instantiate,
	moduleBytes,
	recordsOf,
	specOf,
	writeRecords
} from './c21-common.ts';
import { layoutOf } from './c21-kernels.ts';
import { researchEnvironment } from './environment.ts';

// one pool, one program, calls whose record sizes change: the verdict of a call that stopped must not
// keep a later call with larger records from dispatching
const [id, output, calls = '12', widthArg = '8'] = process.argv.slice(2);
if (!id || !output) throw new Error('usage: size-change.ts ID OUTPUT.jsonl [CALLS] [WIDTH]');
const spec = specOf(id);
const width = Number(widthArg);
const full = recordsOf(spec);
const n = full.length;
const small = full.map((r) => ({
	...r,
	input: r.input.slice(0, Math.max(64, (r.input.length / 16) & ~15))
}));
const layout = layoutOf(
	spec,
	n,
	full.map((r) => r.input.length)
);
const bytes = moduleBytes(spec);
writeFileSync(output, '');
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');
emit({ ...researchEnvironment({ id, n, calls: Number(calls), width }), kind: 'environment' });
const native = instantiate(spec, layout);
if (spec.config) native.exports.setup!(layout.config, 1, spec.config.nfft);
const nativeMs = (records: typeof full) => {
	writeRecords(native.memory, spec, layout, records);
	clearOutput(native.memory, spec, layout, n);
	const start = performance.now();
	native.exports.bulk!(layout.table, n, layout.out);
	return performance.now() - start;
};
const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: 65536, shared: true });
const pool = await Folio.open(bytes, { memory, workers: width });
if (spec.config) await pool.run('setup', [layout.config, 1, spec.config.nfft]);
const pattern = ['small', 'small', 'small', 'full', 'full', 'full'];
for (let call = 0; call < Number(calls); call++) {
	const kind = pattern[call % pattern.length]!;
	const records = kind === 'small' ? small : full;
	const serialMs = nativeMs(records);
	writeRecords(pool.memory, spec, layout, records);
	clearOutput(pool.memory, spec, layout, n);
	admissionSeam.gate = true;
	const start = performance.now();
	const report = await pool.run('bulk', [layout.table, n, layout.out]);
	const wallMs = performance.now() - start;
	emit({
		kind: 'call',
		call,
		sizes: kind,
		serialMs,
		wallMs,
		speedup: serialMs / wallMs,
		mode: report.mode,
		reason: report.reason,
		regions: report.regions
	});
}
await pool.close();
