import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isMainThread, Worker, workerData } from 'node:worker_threads';
import { foldExact, predictEnd, type AffineModel } from '../../src/affine.ts';
import { chunkRanges } from '../../src/fold.ts';
import { serveTasks, TaskPool } from '../../src/tasks.ts';
import { checkStream, toSharedImport } from './stream-check.ts';

// usage: summary-probe.ts OUTPUT.json ; FOLIO_SUMMARY_BINARY names the compiled stream module
// (summary-certify.ts writes it), FOLIO_WIDTH, FOLIO_MIB and FOLIO_ROUNDS size the run

if (!isMainThread) {
	const { module, memory, link, pages } = workerData;
	const shared = new WebAssembly.Instance(module, { env: { memory } }).exports.update as Function;
	const privateMemory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
	const copied = new WebAssembly.Instance(module, { env: { memory: privateMemory } }).exports
		.update as Function;
	serveTasks(link, (name, input) => {
		if (typeof input === 'string') throw new TypeError('expected bytes');
		const [mode, state] = name.split(':');
		let result: number;
		if (mode === 'shared')
			result = shared(parseInt(state!, 16), input.byteOffset, input.length);
		else {
			new Uint8Array(privateMemory.buffer).set(input);
			result = copied(parseInt(state!, 16), 0, input.length);
		}
		const out = new Uint8Array(8);
		new DataView(out.buffer).setBigUint64(0, BigInt(result >>> 0), true);
		return out;
	});
} else {
	const target = process.argv[2];
	if (!target) throw new Error('usage: summary-probe.ts OUTPUT.json');
	if (existsSync(target)) throw new Error(`refusing to overwrite ${target}`);
	const bitStep = `(local.set $s (i32.xor (i32.shr_u (local.get $s) (i32.const 1))
		(i32.and (i32.const -2097792136) (i32.sub (i32.const 0) (i32.and (local.get $s) (i32.const 1))))))`;
	const step = `(func $step (param $s i32) (param $b i32) (result i32)
		(local.set $s (i32.xor (local.get $s) (local.get $b))) ${bitStep.repeat(8)} (local.get $s))`;
	const wat = `(module (import "env" "memory" (memory 1 2048 shared)) ${step}
		(func (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
			(local $i i32) (block $done (loop $again
				(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
				(local.set $s (call $step (local.get $s) (i32.load8_u (i32.add (local.get $p) (local.get $i)))))
				(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $again))) (local.get $s)))`;
	const parsed = binaryen.parseText(wat);
	const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
	parsed.setFeatures(binaryen.Features.All & ~compact);
	type Bits = bigint[];
	const constant = (n: number): Bits =>
		Array.from({ length: 32 }, (_, k) => ((n >>> k) & 1 ? 1n << 64n : 0n));
	const variables = (start: number): Bits =>
		Array.from({ length: 32 }, (_, k) => 1n << BigInt(start + k));
	const locals: Bits[] = [variables(0), variables(32)];
	let checked = 0;
	function symbolic(expr: number): Bits {
		checked++;
		const v = binaryen.getExpressionInfo(expr) as any;
		if (v.id === binaryen.BlockId) {
			let result: Bits = constant(0);
			for (const child of v.children) result = symbolic(child);
			return result;
		}
		if (v.id === binaryen.LocalGetId) {
			assert.ok(locals[v.index]);
			return locals[v.index]!;
		}
		if (v.id === binaryen.LocalSetId) return (locals[v.index] = symbolic(v.value));
		if (v.id === binaryen.ConstId) return constant(v.value);
		if (v.id !== binaryen.BinaryId) throw new Error(`unsupported step opcode ${v.id}`);
		const a = symbolic(v.left),
			b = symbolic(v.right);
		const rawRight = binaryen.getExpressionInfo(v.right) as any;
		if (v.op === binaryen.XorInt32) return a.map((bit, k) => bit ^ b[k]!);
		if (v.op === binaryen.ShrUInt32 && rawRight.id === binaryen.ConstId)
			return a.map((_, k) => a[k + (rawRight.value & 31)] ?? 0n);
		if (v.op === binaryen.AndInt32) {
			const rawLeft = binaryen.getExpressionInfo(v.left) as any;
			if (rawLeft.id === binaryen.ConstId)
				return b.map((bit, k) => ((rawLeft.value >>> k) & 1 ? bit : 0n));
			if (rawRight.id === binaryen.ConstId)
				return a.map((bit, k) => ((rawRight.value >>> k) & 1 ? bit : 0n));
		}
		if (
			v.op === binaryen.SubInt32 &&
			a.every((bit) => bit === 0n) &&
			b.slice(1).every((bit) => bit === 0n)
		)
			return Array(32).fill(b[0]);
		throw new Error(`non-affine or unsupported step operation ${v.op}`);
	}
	const stepInfo = binaryen.getFunctionInfo(parsed.getFunction('step'));
	assert.equal(stepInfo.params, binaryen.createType([binaryen.i32, binaryen.i32]));
	assert.equal(stepInfo.results, binaryen.i32);
	assert.equal(stepInfo.vars.length, 0);
	const expression = symbolic(stepInfo.body);
	assert.equal(expression.length, 32);
	assert.ok(expression.every((bit) => (bit & (1n << 64n)) === 0n));
	const operator = Array.from({ length: 32 }, (_, stateBit) =>
		expression.reduce(
			(out, coefficients, outputBit) =>
				out | (((coefficients >> BigInt(stateBit)) & 1n) << BigInt(outputBit)),
			0n
		)
	);
	const rejected: string[] = [];
	for (const [name, body] of [
		['multiply', '(i32.mul (local.get 0) (local.get 1))'],
		[
			'rare-branch',
			'(if (result i32) (i32.eq (local.get 0) (i32.const 123456789)) (then (i32.const 1)) (else (local.get 0)))'
		],
		['hidden-state', '(global.get $hidden)'],
		[
			'extra-output',
			'(block (result i32) (i32.store (i32.const 0) (local.get 0)) (local.get 0))'
		]
	]) {
		const bad = binaryen.parseText(`(module (memory 1) (global $hidden (mut i32) (i32.const 0))
			(func $bad (param i32 i32) (result i32) ${body}))`);
		assert.throws(() => symbolic(binaryen.getFunctionInfo(bad.getFunction('bad')).body));
		rejected.push(name!);
		bad.dispose();
	}
	let model: AffineModel = {
		kind: 'model',
		ring: 'gf2',
		bits: 32,
		align: 1,
		layout: { entry: 'update', state: 0, ptr: 1, len: 2, bits: 32 },
		operator,
		checks: [],
		calls: 0
	};
	let bytes = Uint8Array.from(parsed.emitBinary());
	parsed.dispose();
	let compiledEvidence: unknown;
	let compiledInputGuard:
		((memoryBytes: number, pointer: number, length: number) => boolean) | undefined;
	if (process.env.FOLIO_SUMMARY_BINARY) {
		const original = new Uint8Array(readFileSync(process.env.FOLIO_SUMMARY_BINARY));
		checkStream(original);
		bytes = toSharedImport(original);
		const checked = checkStream(bytes, 'update', 'transition', { sharedImport: true });
		model = checked.model;
		compiledEvidence = checked.evidence;
		compiledInputGuard = checked.guardInput;
	}
	const WIDTH = Number(process.env.FOLIO_WIDTH ?? 4);
	const MIB = Number(process.env.FOLIO_MIB ?? 8);
	const ROUNDS = Number(process.env.FOLIO_ROUNDS ?? 5);
	const module = new WebAssembly.Module(bytes);
	const pages = MIB * 16 + 2;
	const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
	const input = new Uint8Array(memory.buffer, 0, MIB * 1048576);
	for (let k = 0; k < input.length; k++) input[k] = (Math.imul(k, 17) ^ (k >>> 7)) & 255;
	if (compiledInputGuard)
		assert.ok(compiledInputGuard(memory.buffer.byteLength, input.byteOffset, input.byteLength));
	const native = new WebAssembly.Instance(module, { env: { memory } }).exports.update as Function;
	const pool = new TaskPool(WIDTH);
	const workers = Array.from({ length: WIDTH }, (_, index) => {
		const link = pool.link(index);
		return new Worker(import.meta.filename, {
			workerData: { module, memory, link, pages: Math.ceil((MIB * 16) / WIDTH) + 4 },
			transferList: [link.port]
		});
	});
	const rows: object[] = [];
	try {
		const chunks = chunkRanges(input.length, WIDTH, 1);
		const expected = BigInt(native(0, 0, input.length) >>> 0);
		for (let round = -2; round < ROUNDS; round++) {
			const arms =
				round % 2
					? ['one-shared', 'two-shared', 'one-copy', 'serial']
					: ['serial', 'one-copy', 'two-shared', 'one-shared'];
			for (const arm of arms.filter((a) => a !== 'two-shared' || chunks.length > 1)) {
				let tasks = 0;
				const cpu = process.cpuUsage(),
					start = performance.now();
				const submit = (state: bigint, from: number, to: number) => {
					tasks++;
					return pool.submit(
						`${arm === 'one-copy' ? 'copy' : 'shared'}:${state.toString(16)}`,
						input.subarray(from, to),
						{ share: arm !== 'one-copy' }
					);
				};
				const end = (handle: string) => {
					const bytes = pool.join(handle).bytes;
					return new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, true);
				};
				let state = 0n;
				if (arm === 'serial') state = BigInt(native(0, 0, input.length) >>> 0);
				else if (arm === 'two-shared')
					state = foldExact(chunks, input.length, 0n, {
						zero: 0n,
						submit,
						end,
						equal: (a, b) => a === b,
						predict: (s, n, b) => predictEnd(model, s, n, b)
					}).state;
				else {
					const handles = chunks.map((chunk) => submit(0n, chunk.start, chunk.end));
					for (let k = 0; k < chunks.length; k++)
						state = predictEnd(
							model,
							state,
							chunks[k]!.end - chunks[k]!.start,
							end(handles[k]!)
						);
				}
				assert.equal(state, expected);
				const used = process.cpuUsage(cpu);
				if (round >= 0)
					rows.push({
						arm,
						round,
						inputBytes: input.length,
						tasks,
						exact: true,
						wallMs: performance.now() - start,
						cpuMs: (used.user + used.system) / 1000
					});
			}
		}
	} finally {
		pool.close();
		await Promise.all(workers.map((w) => w.terminate()));
	}
	const out = {
		kind: compiledEvidence
			? 'checked-compiled-stream-wrapper'
			: 'checked-step-generated-wrapper',
		compiledEvidence,
		node: process.version,
		width: WIDTH,
		mib: MIB,
		moduleSha256: createHash('sha256').update(bytes).digest('hex'),
		checkedExpressions: compiledEvidence
			? (compiledEvidence as { expressions: number }).expressions
			: checked,
		rejected: compiledEvidence ? [] : rejected,
		generatedStepControl: compiledEvidence
			? { checkedExpressions: checked, rejected }
			: undefined,
		limitations: [
			compiledEvidence
				? 'checker covers one compiled loop skeleton with a pure step, applied to the executed shared-import module; exclusivity is declared'
				: 'checker covers generated pure CRC step, not arbitrary original stream wrapper',
			'one local process per whole study, order alternated; not independent arm processes',
			'one size/architecture/session, no quiet-machine performance claim'
		],
		rows
	};
	writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
	console.log(JSON.stringify(out));
}
