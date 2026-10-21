import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { parseRows, readRaw, resultsRoot, sha256, stats, type Row } from './lib.ts';

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

// fits the admission cost model to the calibration cells: native speed per estimated unit,
// the serial cost of one region, and the cost of one tracked memory access
export function summarizeAdmission(rows: Row[], hash: string) {
	const cells = rows.filter((row) => row.kind === 'cell');
	assert.ok(cells.length > 0 && cells.every((row) => row.equalMemory));
	const folio = (row: Row, arm: string) => row.arms[arm].medianMs as number;
	const compute = cells.filter((row) => row.shape === 'compute' && row.count > 1);
	const nsPerUnit = median(
		compute.filter((row) => row.trips >= 4096).map((row) => row.nativeNsPerRegion / row.compute)
	);
	// folio time per region = overhead + native time / workers, solved for the overhead
	const overhead = (arm: string, workers: number) =>
		median(
			compute
				.filter((row) => row.trips <= 1024)
				.map((row) => (folio(row, arm) * 1e6) / row.count - row.nativeNsPerRegion / workers)
		) / 1000;
	const stream = cells.filter((row) => row.shape === 'stream' && row.arms['folio-8'].regions > 1);
	const perAccess = (arm: string, workers: number, base: number) =>
		median(
			stream.map(
				(row) =>
					((folio(row, arm) * 1e6) / row.count -
						base * 1000 -
						row.nativeNsPerRegion / workers) /
					row.accesses /
					1000
			)
		);
	const lone = cells.filter((row) => row.shape === 'compute' && row.count === 1);
	const regionOverheadUs = {
		'folio-2': overhead('folio-2', 2),
		'folio-8': overhead('folio-8', 8)
	};
	const accessUs = {
		'folio-2': perAccess('folio-2', 2, regionOverheadUs['folio-2']),
		'folio-8': perAccess('folio-8', 8, regionOverheadUs['folio-8'])
	};
	const worstRegionUs = Math.max(...Object.values(regionOverheadUs));
	const worstAccessUs = Math.max(...Object.values(accessUs));
	return {
		environment: rows.find((row) => row.kind === 'environment'),
		cells: cells.length,
		nsPerUnit,
		regionOverheadUs,
		accessUs,
		accessCostUnits: (worstAccessUs * 1000) / nsPerUnit,
		minimumWorkFor5Percent: (20 * worstRegionUs * 1000) / nsPerUnit,
		// units at which overhead + native / workers equals native: o * w / (w - 1)
		breakEvenUnits: {
			'folio-2': (regionOverheadUs['folio-2'] * 2 * 1000) / nsPerUnit,
			'folio-8': (((regionOverheadUs['folio-8'] * 8) / 7) * 1000) / nsPerUnit
		},
		firstProfitableUnits: Object.fromEntries(
			['folio-2', 'folio-8'].map((arm) => [
				arm,
				compute
					.filter((row) => median(row.arms[arm].pairedSpeedups) > 1)
					.map((row) => row.compute)
					.sort((a, b) => a - b)[0]
			])
		),
		lone: lone.map((row) => ({
			trips: row.trips,
			nativeUs: row.nativeNsPerRegion / 1000,
			overheadUs: (folio(row, 'folio-2') * 1000 - row.nativeNsPerRegion) / 1000,
			speedup: row.arms['folio-2'].speedup
		})),
		breakEven: {
			compute: ['folio-2', 'folio-8'].map((arm) => ({
				arm,
				cells: compute.map((row) => ({
					units: row.compute,
					nativeUs: row.nativeNsPerRegion / 1000,
					speedup: stats(row.arms[arm].pairedSpeedups)
				}))
			})),
			stream: stream.map((row) => ({
				extra: row.extra,
				trips: row.trips,
				compute: row.compute,
				accesses: row.accesses,
				speedup8: row.arms['folio-8'].speedup,
				speedup2: row.arms['folio-2'].speedup
			}))
		},
		hash
	};
}

export function analyzeAdmission(set: string, file = 'admission-calibration.jsonl') {
	const root = resultsRoot(set);
	const raw = readRaw(root, file);
	const summary = summarizeAdmission(parseRows(raw), sha256(raw));
	writeFileSync(
		new URL(file.replace(/\.jsonl$/, '.summary.json'), root),
		`${JSON.stringify(summary, null, 2)}\n`
	);
	return summary;
}

if (import.meta.main) {
	const summary = analyzeAdmission(process.argv[2]!, process.argv[3]);
	console.log(
		JSON.stringify({
			nsPerUnit: summary.nsPerUnit,
			regionOverheadUs: summary.regionOverheadUs,
			accessUs: summary.accessUs,
			accessCostUnits: summary.accessCostUnits,
			minimumWorkFor5Percent: summary.minimumWorkFor5Percent,
			breakEvenUnits: summary.breakEvenUnits,
			firstProfitableUnits: summary.firstProfitableUnits
		})
	);
}
