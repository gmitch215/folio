import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { foldAffine, probeAffine, serveAffine } from '../../src/affine.ts';
import { TaskPool } from '../../src/tasks.ts';
import { checkStream } from './stream-check.ts';

if (!isMainThread && workerData?.link)
	serveAffine(workerData.link, { module: workerData.module, layout: workerData.layout });

const TRIGGER_LENGTH = 262144;
const OFFSET = 1048576;
const crcStep = (rounds = 8) => {
	const round = `(local.set 0 (i32.xor (i32.shr_u (local.get 0) (i32.const 1))
		(i32.and (i32.const 0x82f63b78) (i32.sub (i32.const 0) (i32.and (local.get 0) (i32.const 1))))))`;
	return `(func $step (export "transition") (param i32 i32) (result i32)
		(local.set 0 (i32.xor (local.get 0) (local.get 1))) ${round.repeat(rounds)} (local.get 0))`;
};
const template = (
	tail = '(local.get 0)'
) => `(func $update (export "update") (param i32 i32 i32) (result i32)
	(block $done (br_if $done (i32.eqz (local.get 2)))
		(loop $again
			(local.set 0 (call $step (local.get 0) (i32.load8_u (local.get 1))))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $again (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
	${tail})`;
const counted = (byteExpr: string, tail: string) => `(func $update (export "update")
	(param $s i32) (param $p i32) (param $n i32) (result i32) (local $i i32)
	(block $done (loop $again
		(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
		(local.set $s (call $step (local.get $s) ${byteExpr}))
		(local.set $i (i32.add (local.get $i) (i32.const 1))) (br $again)))
	${tail})`;
const plainByte = '(i32.load8_u (i32.add (local.get $p) (local.get $i)))';
const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
		table[n] = c >>> 0;
	}
	return Buffer.from(table.buffer)
		.toString('hex')
		.replace(/../g, (h) => `\\${h}`);
})();

interface Mutant {
	id: string;
	note: string;
	text: string;
}

// the register reached after 100,000 bytes of the reference input, used as the rare-state trigger
const reference = Uint8Array.from({ length: TRIGGER_LENGTH }, (_, k) => (k * 17 + 31) & 255);
const registerAt = (count: number) => {
	let reg = 0;
	for (let i = 0; i < count; i++) {
		reg = (reg ^ reference[i]!) >>> 0;
		for (let k = 0; k < 8; k++) reg = reg & 1 ? (reg >>> 1) ^ 0x82f63b78 : reg >>> 1;
	}
	return reg >>> 0;
};
const trigger = registerAt(100000);

export const mutants = (): Mutant[] => [
	{
		id: 'control',
		note: 'bitwise CRC-32C step, template wrapper',
		text: `${crcStep()} ${template()}`
	},
	{
		id: 'final-xor',
		note: 'CRC-style final xor applied on every call',
		text: `${crcStep()} ${template('(i32.xor (local.get 0) (i32.const -1))')}`
	},
	{
		id: 'length-trigger',
		note: `one bit flipped when one call covers ${TRIGGER_LENGTH} bytes`,
		text: `${crcStep()} ${counted(
			plainByte,
			`(if (result i32) (i32.eq (local.get $n) (i32.const ${TRIGGER_LENGTH}))
				(then (i32.xor (local.get $s) (i32.const 1))) (else (local.get $s)))`
		)}`
	},
	{
		id: 'length-xor',
		note: 'call length mixed into the result',
		text: `${crcStep()} ${counted(plainByte, '(i32.xor (local.get $s) (local.get $n))')}`
	},
	{
		id: 'position-parity',
		note: 'byte xor index parity',
		text: `${crcStep()} ${counted(
			'(i32.xor (i32.load8_u (i32.add (local.get $p) (local.get $i))) (i32.and (local.get $i) (i32.const 1)))',
			'(local.get $s)'
		)}`
	},
	{
		id: 'equivalent-wrapper',
		note: 'same function through an index-counted loop (benign)',
		text: `${crcStep()} ${counted(plainByte, '(local.get $s)')}`
	},
	{
		id: 'rare-state',
		note: 'step flips a bit when the register hits one value reached mid-stream',
		text: `(func $step (export "transition") (param i32 i32) (result i32)
			(local.set 0 (i32.xor (local.get 0) (local.get 1)))
			${'(local.set 0 (i32.xor (i32.shr_u (local.get 0) (i32.const 1)) (i32.and (i32.const 0x82f63b78) (i32.sub (i32.const 0) (i32.and (local.get 0) (i32.const 1))))))'.repeat(8)}
			(if (result i32) (i32.eq (local.get 0) (i32.const ${trigger | 0}))
				(then (i32.xor (local.get 0) (i32.const 1))) (else (local.get 0))))
			${template()}`
	},
	{
		id: 'nonlinear',
		note: 'state times byte',
		text: `(func $step (export "transition") (param i32 i32) (result i32)
			(i32.add (i32.mul (local.get 0) (i32.or (local.get 1) (i32.const 1))) (i32.const 7)))
			${template()}`
	},
	{
		id: 'poly31',
		note: 'h = h * 31 + byte, affine over Z/2^32',
		text: `(func $step (export "transition") (param i32 i32) (result i32)
			(i32.add (i32.mul (local.get 0) (i32.const 31)) (local.get 1)))
			${template()}`
	},
	{
		id: 'table-crc32',
		note: 'table-driven CRC-32, 256-entry table in a data segment',
		text: `(data (i32.const 0) "${crcTable}")
			(func $step (export "transition") (param i32 i32) (result i32)
			(i32.xor (i32.shr_u (local.get 0) (i32.const 8))
				(i32.load (i32.shl (i32.and (i32.xor (local.get 0) (local.get 1)) (i32.const 255)) (i32.const 2)))))
			${template()}`
	},
	...[1000, 4096, 65537, 100000, 262144].flatMap((k) =>
		(['eq', 'ge_u'] as const).map((op) => ({
			id: `length-${op === 'eq' ? 'eq' : 'ge'}-${k}`,
			note: `bit flipped when n ${op === 'eq' ? '==' : '>='} ${k}`,
			text: `${crcStep()} ${counted(
				plainByte,
				`(if (result i32) (i32.${op} (local.get $n) (i32.const ${k}))
					(then (i32.xor (local.get $s) (i32.const 1))) (else (local.get $s)))`
			)}`
		}))
	),
	{
		id: 'adler32',
		note: 'Adler-32 step, affine over Z/65521 on reduced states',
		text: `(func $step (export "transition") (param i32 i32) (result i32) (local i32)
			(local.set 2 (i32.rem_u (i32.add (i32.and (local.get 0) (i32.const 65535)) (local.get 1)) (i32.const 65521)))
			(i32.or (i32.shl (i32.rem_u (i32.add (i32.shr_u (local.get 0) (i32.const 16)) (local.get 2)) (i32.const 65521)) (i32.const 16)) (local.get 2)))
			${template()}`
	}
];

export const build = (text: string) => {
	const module = binaryen.parseText(`(module (memory (export "memory") 32 512) ${text})`);
	assert.ok(module.validate());
	const bytes = Uint8Array.from(module.emitBinary());
	module.dispose();
	return bytes;
};

async function main(target: string) {
	const rows: object[] = [];
	for (const mutant of mutants()) {
		const bytes = build(mutant.text);
		const wasm = new WebAssembly.Module(bytes);
		const native = new WebAssembly.Instance(wasm).exports as Record<string, any>;
		const memory = native.memory as WebAssembly.Memory;
		new Uint8Array(memory.buffer, OFFSET, reference.length).set(reference);
		const call = (state: number, at: number, length: number) =>
			native.update(state | 0, OFFSET + at, length) >>> 0;
		// ground truth: does a chain of calls over any split equal one call over the whole range
		let composes = true;
		let firstFailure = '';
		for (const length of [0, 1, 7, 64, 1000, 4096, 65537, 100000, TRIGGER_LENGTH]) {
			for (const state of [0, 1, 0x80000000, 0xffffffff]) {
				const whole = call(state, 0, length);
				for (const cut of [Math.floor(length / 3), Math.floor(length / 2), length - 1]) {
					if (cut < 0 || cut > length) continue;
					const chain = call(call(state, 0, cut), cut, length - cut);
					if (chain !== whole && composes) {
						composes = false;
						firstFailure = `length ${length} cut ${cut} state ${state}`;
					}
				}
			}
		}
		const t0 = performance.now();
		const model = probeAffine(bytes, 'update');
		const probeMs = performance.now() - t0;
		const t1 = performance.now();
		let checker: 'accepts' | 'refuses' = 'refuses';
		let checkerReason = '';
		try {
			checkStream(bytes);
			checker = 'accepts';
		} catch (error) {
			checkerReason = String((error as Error).message)
				.split('\n')[0]!
				.slice(0, 80);
		}
		const checkerMs = performance.now() - t1;
		let exact: string = 'no model';
		let exactDetail: object | undefined;
		if (model.kind === 'model') {
			const pool = new TaskPool(4);
			const workers = Array.from({ length: 4 }, (_, index) => {
				const link = pool.link(index);
				return new Worker(import.meta.filename, {
					workerData: { module: wasm, layout: model.layout, link },
					transferList: [link.port]
				});
			});
			try {
				const result = foldAffine(pool, reference, model);
				const whole = BigInt(call(0, 0, TRIGGER_LENGTH));
				exactDetail = {
					mismatchAt: result.mismatchAt,
					fallbackBytes: result.fallbackBytes,
					state: result.state.toString(),
					unsplit: whole.toString()
				};
				exact =
					result.state !== whole
						? 'WRONG'
						: result.mismatchAt >= 0
							? 'correct by fallback'
							: 'correct';
			} finally {
				pool.close();
				await Promise.all(workers.map((w) => w.terminate()));
			}
		}
		rows.push({
			id: mutant.id,
			note: mutant.note,
			moduleSha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
			chainEqualsUnsplit: composes,
			firstFailure,
			probe: model.kind === 'model' ? `model ${model.ring}` : 'refused',
			probeCalls: (model as { calls?: number }).calls ?? null,
			probeMs: Number(probeMs.toFixed(1)),
			exact,
			exactDetail,
			checker,
			checkerReason,
			checkerMs: Number(checkerMs.toFixed(2))
		});
	}
	const out = { kind: 'split-sensitivity-mutation-bench', node: process.version, rows };
	writeFileSync(target, JSON.stringify(out, null, 2) + '\n', { flag: 'wx' });
	for (const r of rows as any[])
		console.log(
			[
				r.id,
				`chain=${r.chainEqualsUnsplit}`,
				r.probe,
				`exact:${r.exact}`,
				`check:${r.checker}`
			].join(' | ')
		);
}

if (isMainThread && import.meta.main) {
	const target = process.argv[2];
	if (!target) throw new Error('usage: split-sensitivity.ts OUTPUT_JSON');
	assert.ok(!existsSync(target), `refusing to overwrite ${target}`);
	await main(target);
}
