import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { digest } from './environment.ts';

type Row = Record<string, any>;

const count = (reasons: string[]) => {
	const counts: Record<string, number> = {};
	for (const reason of reasons) {
		const key = reason
			.replace(/\(.*\)/, '')
			.replace(/\d[\d,]*/g, 'N')
			.trim();
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.fromEntries(
		Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
	);
};

/** Counts the analysis reasons that keep each corpus kernel out of automatic extraction. */
export function blockerHistogram(rows: Row[]) {
	const coverage = rows.filter((row) => row.kind === 'coverage');
	assert.ok(coverage.length, 'no coverage rows');
	return {
		schema: 'folio.blockers.v1',
		kernels: coverage.length,
		originalModule: count(coverage.flatMap((row) => row.original.reasons)),
		admission: count(coverage.flatMap((row) => row.original.controlReasons)),
		sharedBitOnly: count(coverage.flatMap((row) => row.sharedDiagnostic.reasons)),
		checkpointRefusals: count(coverage.flatMap((row) => row.checkpointRefusals))
	};
}

/** Compares each cell's setup identity with later successful operations and counts the evictions. */
export function stateLoss(studies: Record<string, Row>) {
	const result: Record<string, unknown> = {};
	for (const [name, record] of Object.entries(studies)) {
		const rows: Row[] = record.rows;
		const failures = rows.filter((row) => row.passed === false || row.error != null);
		const cells = new Map<string, Row[]>();
		for (const row of rows)
			if (row.result?.module != null)
				cells.set(row.key, [...(cells.get(row.key) ?? []), row]);
		let sameModule = 0,
			otherModule = 0,
			otherObject = 0;
		for (const group of cells.values()) {
			const setup = group.find((row) => row.action === 'setup');
			if (!setup) continue;
			for (const row of group.filter((item) => item.action !== 'setup')) {
				if (row.result.module === setup.result.module) sameModule++;
				else otherModule++;
				if (row.result.object !== setup.result.object) otherObject++;
			}
		}
		const native = failures.filter((row) => row.serial === true).length;
		const messages: Record<string, number> = {};
		for (const row of failures) {
			const message = String(row.error ?? row.failure ?? row.result?.error ?? '').slice(
				0,
				80
			);
			messages[message] = (messages[message] ?? 0) + 1;
		}
		result[name] = {
			cells: cells.size,
			failures: failures.length,
			failuresInNativeCells: native,
			failuresInAutomaticCells: failures.length - native,
			failureMessages: messages,
			laterOperationsSameModule: sameModule,
			laterOperationsOtherModule: otherModule,
			laterOperationsOtherObject: otherObject
		};
	}
	return {
		schema: 'folio.state-loss.v1',
		scope: 'Module identifiers are not isolate identities; object identifiers are routing identities.',
		studies: result
	};
}

if (import.meta.main) {
	const [kind, output, ...inputs] = process.argv.slice(2);
	if (!kind || !output || !inputs.length)
		throw new Error('usage: derive.ts blockers|state-loss OUTPUT.json INPUT...');
	const raw = inputs.map((input) => readFileSync(input));
	const hashes = raw.map(digest);
	let result: Record<string, unknown>;
	if (kind === 'blockers')
		result = blockerHistogram(
			raw.flatMap((bytes) =>
				bytes
					.toString()
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
			)
		);
	else if (kind === 'state-loss')
		result = stateLoss(
			Object.fromEntries(
				inputs.map((input, index) => [
					input
						.split('/')
						.at(-1)!
						.replace(/\.json$/, ''),
					JSON.parse(raw[index]!.toString())
				])
			)
		);
	else throw new Error(`unknown kind: ${kind}`);
	writeFileSync(output, JSON.stringify({ ...result, inputSha256: hashes }, null, 2) + '\n');
	console.log(JSON.stringify({ kind, inputs: inputs.length }));
}
