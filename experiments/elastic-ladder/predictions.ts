import { writeFileSync } from 'node:fs';
import { simulate, simulateTiers, type TierResult } from '../../scripts/research/elastic-model.ts';
import { expectedFor, modelOps } from './plan.ts';
import { PAGE, WORKLOADS, type Workload } from './programs.ts';

export const FRAMES = [4, 16, 64, 256];
export const COLD = [0, 256, 1024];

export interface Prediction extends TierResult {
	workload: Workload;
	pages: number;
	frames: number;
	cold: number;
}

// the model's counts for every cell of the grid, written before the executor runs
export function predictions(pages: number): Prediction[] {
	return WORKLOADS.flatMap((workload) => {
		const ops = modelOps(expectedFor(workload, pages));
		return FRAMES.flatMap((frames) =>
			COLD.map((cold) => ({
				workload,
				pages,
				frames,
				cold,
				...simulateTiers(ops, { frames, cold })
			}))
		);
	});
}

// the older colocated model must agree with the two-tier one when the pool is off
export function colocatedAgrees(pages: number) {
	const ops = modelOps(expectedFor('dense', pages));
	return FRAMES.every((frames) => {
		const old = simulate(ops, {
			name: 'colocated',
			topology: 'colocated',
			frames,
			writePolicy: 'write-back',
			opsPerRequest: Infinity,
			costs: { baseMs: 0, hopMs: 0, putMs: 0, getMs: 0, xferMsPerMiB: 0 }
		});
		const now = simulateTiers(ops, { frames, cold: 0 });
		return old.puts === now.storeWrites && old.gets === now.storeReads;
	});
}

if (import.meta.main) {
	const out = process.argv[2];
	if (!out) throw new Error('usage: predictions.ts OUT.json [pages]');
	const pages = Number(process.argv[3] ?? 3072);
	const doc = {
		schema: 'folio.ladder-predictions.v1',
		note: 'model counts written before the executor ran; pool capacity in pages',
		pageBytes: PAGE,
		pages,
		colocatedModelAgrees: colocatedAgrees(pages),
		rows: predictions(pages)
	};
	writeFileSync(out, `${JSON.stringify(doc, null, '\t')}\n`, { flag: 'wx' });
	console.log(
		JSON.stringify({ wrote: out, rows: doc.rows.length, agrees: doc.colocatedModelAgrees })
	);
}
