import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMiniz } from '../affine-build.ts';
import { specs } from '../c21-kernels.ts';
import { buildHand, handKernels } from './hand-kernels.ts';
import { workerSummarizer } from './morihata-parallel.ts';
import {
	foldChunks,
	infer,
	openStream,
	semiringOf,
	serial,
	type StreamSubject,
	type Verdict
} from './morihata.ts';

// the Morihata and Sato arm over the 38 development drivers and the hand kernels
// usage: morihata-drivers.ts OUTPUT.json

const target = process.argv[2];
if (!target) throw new Error('usage: morihata-drivers.ts OUTPUT.json');
if (existsSync(target)) throw new Error(`refusing to overwrite ${target}`);

const root = new URL('../../../', import.meta.url).pathname;
const probe = JSON.parse(
	readFileSync(join(root, 'results/execution/footprint/probe.json'), 'utf8')
) as { rows: { id: string; carriedEqualsFresh: boolean; permutedEqualsFresh: boolean }[] };

// the verdict applied to a long input on worker threads, against serial
async function atScale(subject: StreamSubject, verdict: Verdict, mib: number) {
	if (verdict.verdict !== 'supported') return undefined;
	const stream = openStream(subject);
	const s = semiringOf(verdict.semiring);
	const input = new Uint8Array(mib << 20);
	for (let i = 0; i < input.length; i++) input[i] = (i * 2654435761) >>> 24;
	const parallel = await foldChunks(stream, s, input, 0n, 4, workerSummarizer(subject, s.name));
	return { mib, equal: parallel === serial(stream, input, 0n) };
}

const brief = (verdict: Verdict) =>
	verdict.verdict === 'supported'
		? {
				verdict: verdict.verdict,
				semiring: verdict.semiring,
				accepted: verdict.accepted,
				combine: verdict.combine
			}
		: { verdict: verdict.verdict, cls: verdict.cls, reason: verdict.reason };

const hand: object[] = [];
for (const kernel of handKernels) {
	const subject = buildHand(kernel);
	const verdict = await infer(subject);
	hand.push({ name: kernel.name, ...brief(verdict), scale: await atScale(subject, verdict, 1) });
}

// the two drivers whose library entry takes (state, pointer, length): the same pinned miniz, no wrapper
const derived: Record<string, object> = {};
for (const [id, entry] of [
	['miniz-crc32', 'mz_crc32'],
	['miniz-adler32', 'mz_adler32']
] as const) {
	const path = buildMiniz(undefined, entry);
	if (!path) {
		derived[id] = {
			verdict: 'not measured',
			reason: 'the miniz archive is not in the corpus cache'
		};
		continue;
	}
	const subject: StreamSubject = {
		module: new Uint8Array(readFileSync(path)),
		entry,
		bits: 32
	};
	const verdict = await infer(subject);
	derived[id] = { ...brief(verdict), scale: await atScale(subject, verdict, 1) };
}

const rows = probe.rows.map((row) => {
	const spec = specs.find((s) => s.id === row.id)!;
	const path = join(root, 'build/research/c21', `${row.id}.wasm`);
	const compiled = new WebAssembly.Module(new Uint8Array(readFileSync(path)));
	const functions = WebAssembly.Module.exports(compiled)
		.filter((e) => e.kind === 'function')
		.map((e) => e.name);
	const imports = WebAssembly.Module.imports(compiled).length;
	const map = row.carriedEqualsFresh && row.permutedEqualsFresh;
	const stateEntry = functions.some((f) => !['bulk', 'bulk_chunks', 'setup'].includes(f));
	const reasons = [
		map ? 'not-a-reduction' : 'carried-state-across-records',
		stateEntry ? 'has-extra-entry' : 'no-state-entry',
		...(spec.arena > 0 ? ['allocator'] : []),
		...(row.id.endsWith('-shared') ? ['shared-scratch'] : [])
	];
	return {
		id: row.id,
		functions,
		imports,
		reasons,
		verdict: 'unsupported',
		derivedEntry: derived[row.id]
	};
});

writeFileSync(
	target,
	JSON.stringify({ kind: 'morihata-dev', node: process.version, rows, hand }, null, 2) + '\n'
);
console.log(
	`${rows.length} drivers, ${rows.filter((r) => r.verdict === 'supported').length} supported`
);
for (const h of hand) console.log(JSON.stringify(h).slice(0, 220));
for (const [id, d] of Object.entries(derived)) console.log(id, JSON.stringify(d).slice(0, 300));
