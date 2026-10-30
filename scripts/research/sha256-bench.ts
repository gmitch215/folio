import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../../src/compiler.ts';
import { Folio } from '../../src/node.ts';
import { researchEnvironment } from './environment.ts';

const root = new URL('../../', import.meta.url).pathname;
const [output, roundsArg = '9', filesArg = '32', kibArg = '256', variant = 'helper'] =
	process.argv.slice(2);
if (!output || !['helper', 'all'].includes(variant))
	throw new Error('usage: sha256-bench.ts OUTPUT.jsonl [ROUNDS] [FILES] [KIB] [helper|all]');
const rounds = Number(roundsArg),
	files = Number(filesArg),
	size = Number(kibArg) * 1024,
	width = 8,
	warmups = 2;
writeFileSync(output, '', { flag: 'wx' });
const emit = (row: Record<string, unknown>) => appendFileSync(output, JSON.stringify(row) + '\n');

const bytes = new Uint8Array(
	readFileSync(join(root, `build/research/sha256/sha256-hash-${variant}.wasm`))
);
const entry = 'sha256_all';

// seeded pseudo-random bytes, one stream per input
const randomInput = (index: number) => {
	let state = Math.imul(index + 1, 2654435761) ^ 0x9e3779b9 || 1;
	const words = new Uint32Array(Math.ceil(size / 4));
	for (let i = 0; i < words.length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		words[i] = state;
	}
	return new Uint8Array(words.buffer, 0, size);
};
const inputs = Array.from({ length: files }, (_, index) => randomInput(index));

const BASE = 1 << 20,
	table = BASE,
	out = BASE + 65536,
	outEnd = out + 32 * files,
	DATA = Math.ceil(outEnd / 65536) * 65536 + 65536;
const pagesAll = Math.ceil((DATA + files * (size + 64)) / 65536) + 2;
const place = (memory: WebAssembly.Memory) => {
	const view = new Uint8Array(memory.buffer);
	const words = new Uint32Array(memory.buffer, table, 2 * files);
	let at = DATA;
	inputs.forEach((data, i) => {
		view.set(data, at);
		words[2 * i] = at;
		words[2 * i + 1] = size;
		at += size + 64;
	});
};
const digests = (memory: WebAssembly.Memory) =>
	Buffer.from(memory.buffer.slice(out, outEnd)).toString('hex');
const sha = (memory: WebAssembly.Memory) =>
	createHash('sha256')
		.update(new Uint8Array(memory.buffer.slice(out, outEnd)))
		.digest('hex');

const nativeMemory = new WebAssembly.Memory({ initial: pagesAll, maximum: pagesAll });
const native = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
	env: { memory: nativeMemory }
}).exports[entry] as CallableFunction;
const nativeRun = () => {
	place(nativeMemory);
	return native(table, files, out);
};
assert.equal(nativeRun(), files, 'returned count');
const expected = sha(nativeMemory);

// every digest equals Node's own SHA-256 of the input
{
	const all = digests(nativeMemory);
	for (let i = 0; i < files; i++)
		assert.equal(
			all.slice(64 * i, 64 * i + 64),
			createHash('sha256').update(inputs[i]!).digest('hex'),
			`digest of input ${i}`
		);
}

// the deepest stack one call uses: fill the stack zone, run one input, find the lowest byte changed
const stackDepth = () => {
	const parsed = binaryen.readBinary(bytes);
	const text = parsed.emitText();
	parsed.dispose();
	const top = Number(
		/\(global \$__stack_pointer \(mut i32\) \(i32\.const (\d+)\)\)/.exec(text)![1]
	);
	const memory = new WebAssembly.Memory({ initial: pagesAll, maximum: pagesAll });
	const fn = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory } }).exports[
		entry
	] as CallableFunction;
	let deepest = 0;
	for (const fill of [0xa5, 0x5a]) {
		const view = new Uint8Array(memory.buffer);
		view.fill(fill, 0, top);
		view.set(inputs[0]!, DATA);
		new Uint32Array(memory.buffer, table, 2).set([DATA, size]);
		fn(table, 1, out);
		let low = 0;
		while (low < top && view[low] === fill) low++;
		deepest = Math.max(deepest, top - low);
	}
	return { stackTop: top, deepestBytes: deepest };
};

const route = prepare(bytes).iterationRoute!;
const { module: _module, ...routeFacts } = route as unknown as Record<string, unknown>;
emit({
	...researchEnvironment({ rounds, files, kibibytes: size / 1024, width, variant }),
	wasmSha256: createHash('sha256').update(bytes).digest('hex'),
	outputSha256: expected,
	nodeDigestsEqual: true,
	stack: stackDepth(),
	iterationRoute: routeFacts
});

type Arm = {
	name: string;
	open: () => Promise<{
		run: () => Promise<void>;
		info: () => object;
		close: () => Promise<void>;
	}>;
};
const folioArm = (armName: string, memoryOf: () => WebAssembly.Memory, shared: boolean): Arm => ({
	name: armName,
	open: async () => {
		const memory = memoryOf();
		const pool = shared
			? await Folio.open(bytes, { memory, workers: width })
			: await Folio.open(bytes, { imports: { env: { memory } }, workers: width });
		let report: any;
		return {
			run: async () => {
				place(pool.memory);
				report = await pool.run(entry, [table, files, out]);
				assert.equal(sha(pool.memory), expected, `${armName} output differs`);
			},
			info: () => ({
				mode: report?.mode,
				extraction: report?.extraction,
				workers: report?.workers,
				regions: report?.regions,
				replayed: report?.replayed,
				fallbacks: report?.fallbacks,
				reason: report?.reason,
				serial: report?.iteration?.serial,
				stopped: report?.iteration?.stopped,
				admission: report?.iteration?.admission,
				dispatchMs: report?.iteration?.dispatchMs,
				validationMs: report?.iteration?.validationMs,
				workerRunMs: report?.iteration?.workerRunMs,
				exhausted: report?.iteration?.exhausted,
				undoEntries: report?.iteration?.undoEntries,
				conflicts: report?.iteration?.conflicts
			}),
			close: () => pool.close()
		};
	}
});
// ponytail: no explicit TaskPool arm; it needs a worker file with a per-input SHA-256 context like blake3-worker.ts
const arms = [
	folioArm(
		'default',
		() => new WebAssembly.Memory({ initial: pagesAll, maximum: pagesAll }),
		false
	),
	folioArm(
		'automatic',
		() => new WebAssembly.Memory({ initial: pagesAll, maximum: 65536, shared: true }),
		true
	)
];
for (const arm of arms) {
	let open: Awaited<ReturnType<Arm['open']>>;
	try {
		open = await arm.open();
	} catch (error) {
		emit({ kind: 'refused', case: arm.name, error: String(error).split('\n')[0] });
		continue;
	}
	try {
		for (let round = -warmups; round < rounds; round++) {
			const order = round % 2 ? ['arm', 'native'] : ['native', 'arm'];
			for (const which of order) {
				const cpu = process.cpuUsage(),
					start = performance.now();
				if (which === 'native') {
					nativeRun();
					assert.equal(sha(nativeMemory), expected, 'native output differs');
				} else await open.run();
				const wallMs = performance.now() - start,
					used = process.cpuUsage(cpu);
				if (round >= 0)
					emit({
						kind: 'sample',
						case: arm.name,
						arm: which === 'native' ? 'native' : arm.name,
						round,
						wallMs,
						cpuMs: (used.user + used.system) / 1000,
						load: loadavg(),
						outputSha256: expected,
						passed: true,
						...(which === 'native' ? {} : { report: open.info() })
					});
			}
		}
	} finally {
		await open.close();
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
}
emit({ kind: 'closed', complete: true });
console.log('done', output);
