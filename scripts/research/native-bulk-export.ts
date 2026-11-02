import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordsOf, specOf, type Record_ } from './c21-common.ts';
import { projectOf, specs, type Spec } from './c21-kernels.ts';
import { corpusManifest } from './corpus.ts';

// flat record file for scripts/research/native-bulk.c, all words little-endian u32:
// magic, n, slot, auxBytes, arena, nfft, configStride, perRecord, then per record
// length, input bytes, aux bytes (auxBytes of them)
export const magic = 0x314b424e;
export const headerWords = 8;

export interface BulkHeader {
	n: number;
	slot: number;
	auxBytes: number;
	arena: number;
	nfft: number;
	configStride: number;
	perRecord: boolean;
}

export const headerOf = (spec: Spec, n: number): BulkHeader => ({
	n,
	slot: spec.slot,
	auxBytes: spec.auxBytes,
	arena: spec.arena,
	nfft: spec.config?.nfft ?? 0,
	configStride: spec.config?.stride ?? 0,
	perRecord: spec.config?.perRecord ?? false
});

export function encodeBulk(header: BulkHeader, records: Record_[]) {
	if (header.n !== records.length) throw new Error('record count differs from the header');
	for (const record of records)
		if (record.aux.length !== header.auxBytes && header.auxBytes)
			throw new Error(`aux is ${record.aux.length} bytes, expected ${header.auxBytes}`);
	const size =
		4 * headerWords + records.reduce((sum, r) => sum + 4 + r.input.length + header.auxBytes, 0);
	const out = Buffer.alloc(size);
	const words = [
		magic,
		header.n,
		header.slot,
		header.auxBytes,
		header.arena,
		header.nfft,
		header.configStride,
		header.perRecord ? 1 : 0
	];
	words.forEach((word, i) => out.writeUInt32LE(word, 4 * i));
	let at = 4 * headerWords;
	for (const record of records) {
		out.writeUInt32LE(record.input.length, at);
		out.set(record.input, at + 4);
		at += 4 + record.input.length;
		if (header.auxBytes) out.set(record.aux, at);
		at += header.auxBytes;
	}
	return out;
}

/** The clang arguments of one driver's library side: defines, include path and source files. */
export function compileArgs(spec: Spec) {
	const project = projectOf(spec.project);
	const kernels = [...corpusManifest.cases, ...corpusManifest.bulkCases].filter(
		(item) => item.project === spec.project
	);
	const sources = [
		...project.sources,
		...(kernels.find((item) => item.id === spec.corpus)?.sources ?? [])
	].map((path) => join(project.dir, path));
	const defines = Object.entries({ SLOT: spec.slot, ...(spec.extra ?? {}) }).map(
		([key, value]) => `-D${key}=${value}`
	);
	return {
		defines: [`-D${spec.define}`, ...defines, ...(project.flags ?? [])],
		include: join(project.dir, project.include),
		sources
	};
}

if (process.argv[1]?.endsWith('native-bulk-export.ts')) {
	const [command, id, file] = process.argv.slice(2);
	if (command === 'list') console.log(specs.map((spec) => spec.id).join('\n'));
	else if (command === 'plan' && id) {
		const plan = compileArgs(specOf(id));
		console.log([...plan.defines, `-I${plan.include}`, ...plan.sources].join('\n'));
	} else if (command === 'data' && id && file) {
		const spec = specOf(id);
		const records = recordsOf(spec);
		writeFileSync(file, encodeBulk(headerOf(spec, records.length), records));
	} else {
		console.error('usage: native-bulk-export.ts list | plan ID | data ID FILE');
		process.exit(2);
	}
}
