import binaryen from 'binaryen';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { distribution, summarizeResearch } from '../../scripts/research/analyze.ts';
import { speedupCounts } from '../../scripts/research/denominators.ts';
import { blockerHistogram, stateLoss } from '../../scripts/research/derive.ts';
import { generatedProgram, runDifferential } from '../../scripts/research/differential.ts';
import { digest } from '../../scripts/research/environment.ts';
import { verifyStudies } from '../../scripts/research/evidence.ts';
import { exportStudy } from '../../scripts/research/export.ts';
import { addresses } from '../../scripts/research/graded.ts';

const sample = (
	arm: string,
	round: number,
	wallMs: number,
	extra: Record<string, unknown> = {}
) => ({
	kind: 'sample',
	case: 'cell',
	arm,
	round,
	wallMs,
	cpuMs: wallMs * 2,
	outputSha256: 'same',
	passed: true,
	...extra
});

test('the analyzer divides native by each arm inside the same round and counts routing reasons', () => {
	const rows = [
		sample('native', 0, 10),
		sample('folio', 0, 5, {
			report: { mode: 'speculative', workers: 4, replayed: 2, reason: 'dependency' }
		}),
		sample('native', 1, 12),
		sample('folio', 1, 4, {
			report: { mode: 'serial', workers: 0, replayed: 0, reason: 'dependency' }
		})
	];
	const summary = summarizeResearch(rows, 'hash') as any;
	const arm = summary.groups.cell.folio;
	expect(arm.pairedSpeedup.median).toBe(2.5);
	expect(arm.cpuRatio.median).toBeCloseTo((0.5 + 4 / 12) / 2, 10);
	expect(arm.reasons).toEqual({ dependency: 2 });
	expect(arm.replayed).toBe(2);
	expect(arm.modes).toEqual(['speculative', 'serial']);
});

test('repeated calls inside one round pair by call index, and bad samples are refused', () => {
	const rows = [0, 1].flatMap((call) => [
		sample('native', 0, 10, { call }),
		sample('adaptive', 0, call === 0 ? 20 : 5, {
			call,
			reason: call ? 'previous-conflicts' : undefined
		})
	]);
	const arm = (summarizeResearch(rows, 'hash') as any).groups.cell.adaptive;
	expect(arm.pairedSpeedup.n).toBe(2);
	expect(arm.pairedSpeedup.max).toBe(2);
	expect(arm.reasons).toEqual({ 'previous-conflicts': 1 });
	expect(() =>
		summarizeResearch(
			[sample('native', 0, 1), sample('folio', 0, 1, { outputSha256: 'other' })],
			'h'
		)
	).toThrow(/different outputs/);
	expect(() => summarizeResearch([sample('native', 0, 1), sample('native', 0, 1)], 'h')).toThrow(
		/duplicate/
	);
	expect(() => summarizeResearch([sample('native', 0, 1, { passed: false })], 'h')).toThrow();
	expect(distribution([3, 1, 2])).toMatchObject({ n: 3, median: 2, min: 1, max: 3 });
});

test('the generated grammar reaches all seven shapes and every shape is valid Wasm', () => {
	const shapes = new Map<number, string>();
	for (let seed = 1; shapes.size < 7 && seed < 500; seed++) {
		const program = generatedProgram(seed);
		if (!shapes.has(program.shape)) shapes.set(program.shape, program.wat);
	}
	expect([...shapes.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
	for (const wat of shapes.values()) {
		const module = binaryen.parseText(wat);
		module.setFeatures(binaryen.Features.All);
		expect(module.validate()).toBeTruthy();
		module.dispose();
	}
});

test('the differential campaign exercises guard refusal, traps and host exceptions with equal results', async () => {
	const rows: Record<string, unknown>[] = [];
	const totals = await runDifferential({
		seed: 12648430,
		programs: 1,
		widths: [2],
		emit: (row) => rows.push(row)
	});
	expect(totals.guardFallback).toBeGreaterThan(0);
	expect(totals.traps).toBeGreaterThan(0);
	expect(totals.hostThrows).toBeGreaterThan(0);
	const comparisons = rows.filter((row) => row.kind === 'comparison');
	expect(comparisons.length).toBe(totals.comparisons);
	expect(comparisons.every((row) => row.passed)).toBe(true);
});

test('graded conflict batches send the chosen fraction of calls to one shared address', () => {
	const hotCount = (fraction: number) =>
		addresses(fraction).filter((address) => address === 1024).length;
	expect(hotCount(0)).toBe(0);
	expect(hotCount(1 / 4)).toBe(16);
	expect(hotCount(1)).toBe(64);
	expect(new Set(addresses(0)).size).toBe(64);
});

test('study verification checks manifest bytes and hashes and refuses escaping paths', () => {
	const root = mkdtempSync(join(tmpdir(), 'folio-studies-'));
	try {
		const study = join(root, 'results', 'topic', 'study');
		mkdirSync(study, { recursive: true });
		writeFileSync(join(root, 'results', 'outside.txt'), 'outside');
		writeFileSync(join(study, 'README.md'), '# Study\n');
		writeFileSync(join(study, 'raw.jsonl'), '{"a":1}\n');
		const entry = (path: string, data: string) => ({
			path,
			bytes: Buffer.byteLength(data),
			sha256: digest(data)
		});
		const manifest = (artifacts: unknown[]) =>
			writeFileSync(
				join(study, 'manifest.json'),
				JSON.stringify({ schema: 'folio.study.v1', artifacts })
			);
		manifest([entry('raw.jsonl', '{"a":1}\n')]);
		expect(verifyStudies(root)).toEqual({ studies: 1, artifacts: 1, bytes: 8 });
		manifest([entry('raw.jsonl', '{"a":2}\n')]);
		expect(() => verifyStudies(root)).toThrow(/artifact hash/);
		manifest([entry('../../outside.txt', 'outside')]);
		expect(() => verifyStudies(root)).toThrow(/escapes study/);
		manifest([entry('raw.jsonl', '{"a":1}\n'), entry('raw.jsonl', '{"a":1}\n')]);
		expect(() => verifyStudies(root)).toThrow(/duplicate/);
		manifest([]);
		rmSync(join(study, 'README.md'));
		expect(() => verifyStudies(root)).toThrow(/missing study README/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('the analyzer skips pairs whose native process CPU reads zero', () => {
	const rows = [
		sample('native', 0, 1, { cpuMs: 0 }),
		sample('folio', 0, 2, { cpuMs: 4 }),
		sample('native', 1, 1, { cpuMs: 2 }),
		sample('folio', 1, 2, { cpuMs: 4 })
	];
	const arm = (summarizeResearch(rows, 'hash') as any).groups.cell.folio;
	expect(arm.cpuRatio.n).toBe(1);
	expect(arm.cpuRatioPairs).toBe(1);
	expect(arm.cpuRatio.median).toBe(2);
});

test('blocker counts merge numbers and state-loss counts compare setup identities', () => {
	const coverage = (reasons: string[]) => ({
		kind: 'coverage',
		original: {
			reasons,
			controlReasons: ['no region reached 200000 net work (5 pure functions)']
		},
		sharedDiagnostic: { reasons: reasons.slice(1) },
		checkpointRefusals: []
	});
	const blockers = blockerHistogram([
		coverage(['shared wasm32 memory required', 'unsupported expression 11']),
		coverage(['shared wasm32 memory required', 'unsupported expression 7'])
	]);
	expect(blockers.originalModule).toEqual({
		'shared wasmN memory required': 2,
		'unsupported expression N': 2
	});
	expect(blockers.admission).toEqual({ 'no region reached N net work': 2 });
	const row = (action: string, module: string, object = 'o') => ({
		key: 'cell',
		action,
		result: { module, object }
	});
	const loss = stateLoss({
		study: {
			rows: [
				row('setup', 'm1'),
				row('operation', 'm1'),
				row('operation', 'm2'),
				{
					key: 'cell',
					action: 'operation',
					passed: false,
					serial: true,
					error: 'Error: owner was evicted'
				}
			]
		}
	}) as any;
	expect(loss.studies.study).toMatchObject({
		failures: 1,
		failuresInNativeCells: 1,
		failuresInAutomaticCells: 0,
		laterOperationsSameModule: 1,
		laterOperationsOtherModule: 1,
		laterOperationsOtherObject: 0
	});
});

test('exporting a study summarizes every sampled record and writes a verifiable manifest', () => {
	const root = mkdtempSync(join(tmpdir(), 'folio-export-'));
	try {
		const source = join(root, 'input.jsonl');
		writeFileSync(
			source,
			[sample('native', 0, 2), sample('folio', 0, 1)]
				.map((row) => JSON.stringify(row))
				.join('\n') + '\n'
		);
		const study = join(root, 'results', 'topic', 'study');
		mkdirSync(study, { recursive: true });
		writeFileSync(join(study, 'README.md'), '# Study\n');
		expect(exportStudy(study, [`${source}:raw.jsonl`, `${source}:second.jsonl`])).toBe(5);
		expect(verifyStudies(root).studies).toBe(1);
		expect(() => exportStudy(study, [`${source}:raw.jsonl`])).toThrow(/refusing to overwrite/);
		const summary = JSON.parse(readFileSync(join(study, 'second.summary.json'), 'utf8'));
		expect(summary.groups.cell.folio.pairedSpeedup.median).toBe(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('speedup counts compare each kernel median with every bar', () => {
	const group = (median: number) => ({ 'tasks-8-batched': { pairedSpeedup: { median } } });
	const summary = { groups: { a: group(0.9), b: group(2), c: group(3.5) } };
	expect(speedupCounts(summary, 'tasks-8-batched', [1, 2, 3])).toEqual({
		kernels: 3,
		atLeast1x: 2,
		atLeast2x: 2,
		atLeast3x: 1
	});
});
