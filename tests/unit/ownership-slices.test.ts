import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { sameError } from '../../scripts/research/iteration-diff.ts';
import {
	ARENA,
	BASES,
	DATA,
	iterModuleOf,
	layoutRecords,
	OUT,
	RECORDS,
	TABLE
} from '../../scripts/research/ownership-modules.ts';
import { ownershipSlices, OwnershipSlicesError } from '../../src/ownership-slices.ts';
import { certifyOwnership, type OwnershipCertificate } from '../../src/ownership.ts';
import type { OwnedSliceReport } from '../../src/slices.ts';

const MAX = 40;
const bytes = iterModuleOf(BASES.scratch!, undefined, MAX);
const certificate = certifyOwnership(bytes) as OwnershipCertificate;
const regions: [number, number][] = [
	[TABLE, TABLE + 16 * RECORDS],
	[DATA, DATA + 320 * RECORDS],
	[OUT, OUT + 64 * RECORDS],
	[ARENA, ARENA + 64 * RECORDS]
];
const writes: [number, number][] = [[OUT, OUT + 64 * RECORDS]];

const fill = (memory: WebAssembly.Memory, seed: number, trap: number) => {
	const view = new Uint8Array(memory.buffer);
	layoutRecords(view, new Uint32Array(memory.buffer), seed);
	for (let a = 4096; a < 4352; a++) view[a] = (a * 7 + 3) & 255;
	if (trap >= 0) new Uint32Array(memory.buffer)[(TABLE + 16 * trap) / 4] = 0xfffffff0;
};

function serial(seed: number, trap: number) {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: MAX });
	const instance = new WebAssembly.Instance(new WebAssembly.Module(Uint8Array.from(bytes)), {
		env: { memory }
	});
	fill(memory, seed, trap);
	let error: unknown;
	try {
		(instance.exports.bulk as (...a: number[]) => void)(TABLE, RECORDS, OUT);
	} catch (caught) {
		error = caught;
	}
	return { view: new Uint8Array(memory.buffer), error };
}

async function session<T>(
	workers: number,
	body: (run: (seed: number, trap: number, limit?: number) => Promise<Routed>) => Promise<T>
) {
	const memory = new WebAssembly.Memory({ initial: 8, maximum: MAX, shared: true });
	const pool = await ownershipSlices(bytes, certificate, { memory, workers });
	try {
		return await body(async (seed, trap, limit) => {
			new Uint8Array(memory.buffer).fill(0, 0, pool.privateBase);
			fill(memory, seed, trap);
			let error: unknown;
			let report;
			try {
				report = await pool.run(
					RECORDS,
					(from, to) => [TABLE + 16 * from, to - from, OUT + 64 * from],
					{ regions, writes, snapshotLimit: limit }
				);
			} catch (caught) {
				error = caught;
			}
			return {
				view: new Uint8Array(memory.buffer).slice(0, pool.privateBase),
				error,
				report: report?.ownership
			};
		});
	} finally {
		await pool.close();
	}
}

interface Routed {
	view: Uint8Array;
	error: unknown;
	report?: OwnedSliceReport;
}

describe('ownership slices', () => {
	test('the redirected slices leave the serial bytes at every width', async () => {
		assert.equal(certificate.kind, 'certificate');
		for (const workers of [1, 3])
			await session(workers, async (run) => {
				for (const seed of [1, 2, 3]) {
					const want = serial(seed, -1);
					const got = await run(seed, -1);
					assert.equal(got.error, undefined);
					assert.equal(got.report!.replayed, false);
					assert.deepEqual(
						got.view,
						want.view.subarray(0, got.view.length),
						`seed ${seed}`
					);
				}
			});
	});

	test('a trap restores the writes and the serial run leaves its own memory and trap', async () => {
		await session(3, async (run) => {
			const want = serial(2, 5);
			assert.ok(want.error);
			const got = await run(2, 5);
			assert.ok(sameError(want.error, got.error));
			assert.deepEqual(got.view, want.view.subarray(0, got.view.length));
			// records after the trap have not run and their slots hold the baseline
			assert.ok(got.view.subarray(OUT + 64 * 6, OUT + 64 * RECORDS).every((b) => b === 0));
			// the next clean run on the same pool is not affected by the trapped one
			const clean = await run(1, -1);
			assert.equal(clean.report!.replayed, false);
			assert.deepEqual(clean.view, serial(1, -1).view.subarray(0, clean.view.length));
			// a copy of the writes past the limit is refused and the calls run serially in place
			const refused = await run(1, -1, 8);
			assert.equal(refused.report!.refused, 'snapshot');
			assert.deepEqual(refused.view, clean.view);
		});
	});

	test('a store at an address no record owns certifies but is refused by the slice route', async () => {
		assert.equal(certificate.wildStores, 0);
		const wild = iterModuleOf(BASES.fill!, 'wide-dynamic-store', MAX);
		const wildCertificate = certifyOwnership(wild) as OwnershipCertificate;
		assert.equal(wildCertificate.kind, 'certificate');
		assert.ok(wildCertificate.wildStores > 0);
		const memory = new WebAssembly.Memory({ initial: 8, maximum: MAX, shared: true });
		await assert.rejects(
			ownershipSlices(wild, wildCertificate, { memory, workers: 1 }),
			(error: OwnershipSlicesError) => error.code === 'wild-store'
		);
	});

	test('a record region that meets a window is refused before the run', async () => {
		const memory = new WebAssembly.Memory({ initial: 8, maximum: MAX, shared: true });
		const pool = await ownershipSlices(bytes, certificate, { memory, workers: 2 });
		try {
			await assert.rejects(
				pool.run(RECORDS, (from, to) => [TABLE + 16 * from, to - from, OUT + 64 * from], {
					regions: [...regions, [4100, 4200]],
					writes
				}),
				OwnershipSlicesError
			);
		} finally {
			await pool.close();
		}
	});
});
