import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { summarizePaired } from '../../scripts/analyze/paired.ts';
import { exportNames, summarizeProfile } from '../../scripts/analyze/profile.ts';
import { measure, type Consumer } from '../../scripts/probe/consumer.ts';
import { census } from '../../scripts/probe/purity-census.ts';
import { validateSourcePath, verifySource } from '../../scripts/research/corpus.ts';
import { digest } from '../../scripts/research/environment.ts';
import { verifyEvidence } from '../../scripts/research/evidence.ts';

test('evidence validation refuses traversal, duplicate records and corrupted bytes', () => {
	const root = mkdtempSync(join(tmpdir(), 'folio-evidence-test-'));
	mkdirSync(join(root, 'results/study'), { recursive: true });
	writeFileSync(join(root, 'results/study/README.md'), 'method');
	writeFileSync(join(root, 'results/study/raw.json'), 'raw');
	const record = {
		path: 'results/study/raw.json',
		origin: 'raw.json',
		bytes: 3,
		sha256: digest('raw')
	};
	expect(verifyEvidence(root, [record])).toEqual({ artifacts: 1, bytes: 3 });
	expect(() => verifyEvidence(root, [{ ...record, path: '../outside' }])).toThrow(/escapes/);
	expect(() => verifyEvidence(root, [record, record])).toThrow(/duplicate/);
	writeFileSync(join(root, record.path), 'bad');
	expect(() => verifyEvidence(root, [record])).toThrow(/hash/);
});

test('corpus extraction rejects escaping archive paths and altered source archives', () => {
	for (const path of ['', '../source.c', '/source.c', 'a/../../source.c', 'a\\source.c']) {
		expect(() => validateSourcePath(path)).toThrow();
	}
	expect(() => validateSourcePath('library/src/hash.c')).not.toThrow();
	const bytes = Uint8Array.of(1, 2, 3);
	expect(() => verifySource(bytes, digest(bytes))).not.toThrow();
	expect(() => verifySource(Uint8Array.of(1, 2, 4), digest(bytes))).toThrow();
});

const compile = (text: string) => {
	const module = binaryen.parseText(text);
	assert.ok(module.validate());
	const bytes = module.emitBinary();
	module.dispose();
	return bytes;
};

test('the purity census names the first rule that keeps a function out of a region', () => {
	const bytes = compile(`(module
		(import "env" "f" (func $imported))
		(memory 1)
		(table 1 funcref)
		(type $void (func))
		(global $sp (mut i32) (i32.const 1024))
		(func $leaf (export "leaf") (param i32) (i32.store (local.get 0) (i32.const 1)))
		(func $stacky (param i32)
			(global.set $sp (i32.sub (global.get $sp) (i32.const 16)))
			(i32.store (local.get 0) (i32.const 1))
			(global.set $sp (i32.add (global.get $sp) (i32.const 16))))
		(func $indirect (call_indirect (type $void) (i32.const 0)))
		(func $viaImport (call $imported))
		(func $callsLeaf (param i32) (call $leaf (local.get 0)))
		(func $callsStacky (param i32) (call $stacky (local.get 0))))`);
	const result = census(bytes, 'fixture.wasm');
	expect(result.definedFunctions).toBe(6);
	expect(result.firstBlockingReason).toEqual({
		pure: 2,
		'stack pointer': 1,
		call_indirect: 1,
		'calls an import': 1,
		'calls an impure function': 1
	});
	expect(result.pure).toBe(2);
	expect(result.pureIfStackPointerAllowed).toBe(4);
	expect(result.pureNames).toContain('leaf');
});

test('profile samples land on exported wasm function names', () => {
	const wasm = compile(
		'(module (func (export "alpha")) (func (export "beta")) (func $hidden (param i32)))'
	);
	assert.deepEqual(
		[...exportNames(wasm)],
		[
			[0, 'alpha'],
			[1, 'beta']
		]
	);
	const frame = (id: number, functionName: string) => ({ id, callFrame: { functionName } });
	const profile = {
		nodes: [frame(1, 'wasm-function[0]'), frame(2, 'wasm-function[2]'), frame(3, 'parse')],
		samples: [1, 1, 1, 2, 3],
		timeDeltas: [1000, 1000, 1000, 1000, 5000]
	};
	const summary = summarizeProfile(gzipSync(JSON.stringify(profile)), wasm);
	expect(summary.sampledMs).toBe(9);
	expect(summary.wasmMs).toBe(4);
	expect(summary.top).toEqual([
		{ name: 'alpha', selfMs: 3, shareOfWasm: 0.75 },
		{ name: 'index 2', selfMs: 1, shareOfWasm: 0.25 }
	]);
	expect(summary.unexportedWasmMs).toBe(1);
	expect(summary.functionsCoveringHalfOfWasmTime).toBe(1);
});

const sample = (arm: string, round: number, wallMs: number, cpuMs: number, extra = {}) => ({
	kind: 'sample',
	name: 'case',
	arm,
	round,
	wallMs,
	cpuMs,
	outputSha256: `digest-${round}`,
	passed: true,
	load: [1],
	...extra
});

test('paired summaries divide native by folio inside each round', () => {
	const dispatched = { workers: 2, regions: 3, replayed: 0, fallbacks: 0, mode: 'speculative' };
	const rows = [
		{ kind: 'environment' },
		sample('native', 0, 10, 10),
		sample('folio-2', 0, 5, 12, { dispatched }),
		sample('native', 1, 20, 20),
		sample('folio-2', 1, 10, 21, { dispatched })
	];
	const summary = summarizePaired(rows, 'hash');
	const arms = summary.workloads.case as Record<string, any>;
	expect(arms['folio-2'].pairedSpeedup).toEqual({ n: 2, median: 2, min: 2, max: 2 });
	expect(arms['folio-2'].cpuRatio.n).toBe(2);
	expect(arms['folio-2'].workersDispatched.max).toBe(2);
	expect(arms.native.pairedSpeedup).toBeUndefined();
	const diverged = [...rows, sample('folio-2', 1, 9, 9, { outputSha256: 'other' })];
	expect(() => summarizePaired(diverged, 'hash')).toThrow(/outputs differ/);
});

const adder = (random = false): Consumer => ({
	name: 'adder',
	bytes: compile(`(module
		(import "env" "noise" (func $noise (result i32)))
		(memory (export "memory") 1)
		(func (export "add") (param i32 i32) (result i32)
			(i32.store (i32.const 8) (i32.add (local.get 0) (local.get 1)))
			(i32.add (i32.load (i32.const 8)) ${random ? '(call $noise)' : '(i32.const 0)'})))`),
	imports: () => ({
		imports: { env: { noise: () => (random ? Math.floor(Math.random() * 1e9) : 0) } }
	}),
	cases: [{ name: 'sum', prepare: () => [{ export: 'add', args: [2, 3] }] }]
});

test('the harness alternates arms and reports matching rows for a deterministic consumer', async () => {
	const rows = await measure(adder(), { pairs: 2, warmup: 1, widths: [1] });
	const samples = rows.filter((row) => row.kind === 'sample');
	expect(rows[0]!.arms).toEqual(['native', 'folio-1']);
	expect(samples.map((row) => `${row.round}:${row.arm}`)).toEqual([
		'0:folio-1',
		'0:native',
		'1:native',
		'1:folio-1'
	]);
	expect(
		new Set(samples.filter((row) => row.round === 0).map((row) => row.outputSha256)).size
	).toBe(1);
	expect(rows.at(-1)!.kind).toBe('closed');
	const summary = summarizePaired(rows, 'hash');
	expect((summary.workloads['adder/sum'] as any)['folio-1'].pairedSpeedup.n).toBe(2);
});

test('the harness refuses a consumer whose arms disagree', async () => {
	await expect(measure(adder(true), { pairs: 1, warmup: 0, widths: [1] })).rejects.toThrow(
		/differ from native/
	);
});
