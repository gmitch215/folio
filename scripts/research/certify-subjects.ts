import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { certifyStream } from '../../src/certify.ts';
import { buildMiniz, buildOutputSubjects, buildSubjects } from './affine-build.ts';
import { groundTruth } from './certify-ground.ts';
import { build, mutants } from './split-sensitivity.ts';

// the stream certifier on the real compiled subjects and on the 21 constructed split-sensitivity modules
// usage: certify-subjects.ts OUTPUT.json

const target = process.argv[2];
if (!target) throw new Error('usage: certify-subjects.ts OUTPUT.json');
if (existsSync(target)) throw new Error(`refusing to overwrite ${target}`);

const paths = { ...buildSubjects(), ...buildOutputSubjects() };
const miniz = buildMiniz();
if (miniz) paths['miniz-crc32'] = miniz;
const minizAdler = buildMiniz(undefined, 'mz_adler32');
if (minizAdler) paths['miniz-adler32'] = minizAdler;

const rows: object[] = [];
const run = (kind: string, name: string, bytes: Uint8Array, entry: string, validate: boolean) => {
	const start = performance.now();
	const result = certifyStream(bytes, entry);
	const ms = performance.now() - start;
	const row: Record<string, unknown> = { kind, name, entry, certifyMs: Math.round(ms * 10) / 10 };
	if (result.kind === 'certificate') {
		row.verdict = 'certified';
		row.ring = result.ring;
		row.bits = result.bits;
		row.zeroLength = result.zeroLength;
		if (result.output)
			row.output = {
				inPlace: true,
				step: result.output.step?.toString() ?? 'reads the bytes'
			};
		row.stats = result.stats;
		row.initializationBytes = result.initialization.reduce((n, w) => n + w.hex.length / 2, 0);
		row.exclusions = result.exclusions;
		row.moduleSha256 = result.moduleSha256;
		if (validate) row.groundTruth = groundTruth(bytes, result, undefined, 1 << 20) || 'agrees';
	} else {
		row.verdict = 'refused';
		row.reason = result.reason;
	}
	rows.push(row);
	console.log(
		name,
		row.verdict,
		row.ring ?? '',
		`${row.certifyMs}ms`,
		row.groundTruth ?? row.reason ?? ''
	);
};

for (const [name, path] of Object.entries(paths)) {
	const bytes = new Uint8Array(readFileSync(path));
	const entry = name.startsWith('miniz-')
		? Object.keys(new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports).find(
				(e) => e !== 'memory'
			)!
		: name;
	run('real', name, bytes, entry, true);
}
for (const m of mutants()) run('constructed', m.id, build(m.text), 'update', true);

writeFileSync(
	target,
	JSON.stringify({ kind: 'certifier-subjects', node: process.version, rows }, null, 2) + '\n'
);
