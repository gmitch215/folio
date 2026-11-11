import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const KILL_LINE_MIB = 203;
export const CAP_MS = 15000;
export const PAGES_PER_MIB = 16;

const elasticDir = new URL('../../experiments/elastic-ladder/', import.meta.url);

// sha256 of each prediction file, pinned in scratchpad/v11/w5/E2-LIVE-3.md before any day 3 run
const prereg = {
	C: {
		file: 'day3-predictions.json',
		sha256: 'ddc071de6fb5411292edbd8a5bd218a0e4c2d052addd518d6ba7bc489dd83de6'
	},
	B2: {
		file: 'day2-predictions-nnls.json',
		sha256: '36f4508aec17d5557a8ddfcf7d6a45dfca8eb94ae3a9a50cdb760b0ef3ac0694'
	},
	B1: {
		file: 'day2-predictions.json',
		sha256: '6eae40aff8b0742bf89eb5267c03df99304d17207838601d0aead81bd31eeaaf'
	}
} as const;

export type ModelName = keyof typeof prereg;

export interface Coefficients {
	baseMs: number;
	readMs: number;
	writeMs: number;
	codecMs: number;
}

export interface Model {
	name: ModelName;
	coefficients: Coefficients;
	// declared domain: the store-op counts of the runs the model was fitted on
	reads: [number, number];
	writes: [number, number];
}

export function loadModel(name: ModelName): Model {
	const { file, sha256 } = prereg[name];
	const text = readFileSync(new URL(file, elasticDir), 'utf8');
	// the pin is the tab-indented form; the commit hook reformats the file
	const canonical = `${JSON.stringify(JSON.parse(text), null, '\t')}\n`;
	const digest = createHash('sha256').update(canonical).digest('hex');
	if (digest !== sha256) {
		throw new Error(`${file}: sha256 ${digest} is not the pre-registered ${sha256}`);
	}
	const json = JSON.parse(text) as {
		fit: Coefficients;
		fitSet: { storeReads: number; storeWrites: number }[];
	};
	const reads = json.fitSet.map((r) => r.storeReads);
	const writes = json.fitSet.map((r) => r.storeWrites);
	return {
		name,
		coefficients: json.fit,
		reads: [Math.min(...reads), Math.max(...reads)],
		writes: [Math.min(...writes), Math.max(...writes)]
	};
}

// memory.buffer MiB at route end on the 32 MiB control build (E-L0B-RESULT.md:15-21),
// the same route at 4 MiB (same rows, 4 MiB column), and the saving at 4 MiB alone
// (last column of the same rows). floor4 is the saving with the import lowered to 256
// pages on the four routes that were run that way (E-L0B-RESULT.md:23).
export interface Route {
	name: string;
	linear: number;
	linear4: number;
	save4: number;
	floor4?: number;
}

export const routes: Route[] = [
	{ name: 'thunder login', linear: 72.3, linear4: 64.0, save4: 8.3, floor4: 28.0 },
	{ name: 'thunder cim (config import)', linear: 87.9, linear4: 64.0, save4: 23.9, floor4: 28.4 },
	{ name: 'thunder admin', linear: 99.5, linear4: 71.8, save4: 27.7 },
	{ name: 'thunder modules', linear: 100.5, linear4: 71.8, save4: 28.7 },
	{ name: 'thunder flush', linear: 122.1, linear4: 93.8, save4: 28.3, floor4: 28.1 },
	{ name: 'stock front', linear: 82.9, linear4: 64.0, save4: 18.9, floor4: 28.1 },
	{ name: 'stock admin', linear: 93.6, linear4: 65.4, save4: 28.2 },
	{ name: 'stock modules', linear: 93.8, linear4: 66.1, save4: 27.8 },
	{ name: 'stock flush', linear: 107.2, linear4: 78.8, save4: 28.4 }
];

// platform meter minus linear memory, booted interpreter, Thunder (the stock probe gives 37, one deploy)
// low: M1 ratcheted isolate stage S6, 163 at linear 106 (14-thunder-baseline-62.notes.md, M1 column)
// central: B4 quiet probe, 185-186 at linear 99 (14-thunder-baseline-62.notes.md:82)
// high: M2 stage S1 after a drop, 190 at linear 64 (14-thunder-baseline-62.notes.md, M2 column)
export const meterOffsetMiB = {
	low: 57,
	central: 86.5,
	high: 126
} as const;

export type Scenario = keyof typeof meterOffsetMiB;
export const scenarios = Object.keys(meterOffsetMiB) as Scenario[];

// day 2 steps 4 and 9: 768 pages, 768 frames against 64 frames (E2-LIVE-2-RESULT.md, steps 4 and 9)
export const spillReadMs = (978.3 - 736.3) / 766;

export function meterMiB(route: Route, scenario: Scenario) {
	return route.linear + meterOffsetMiB[scenario];
}

// positive means the route is over the kill line by that many MiB
export function remainingMiB(route: Route, scenario: Scenario, saving: number, slope = 1) {
	return meterMiB(route, scenario) - slope * saving - KILL_LINE_MIB;
}

export function spillPages(mib: number) {
	return mib > 0 ? Math.ceil(mib * PAGES_PER_MIB) : 0;
}

export function storeMsPerPage(model: Model) {
	return model.coefficients.readMs + model.coefficients.writeMs;
}

export function breakEvenPages(model: Model) {
	return (CAP_MS - model.coefficients.baseMs) / storeMsPerPage(model);
}

export function inDomain(model: Model, pages: number) {
	return (
		pages >= Math.max(model.reads[0], model.writes[0]) &&
		pages <= Math.min(model.reads[1], model.writes[1])
	);
}

export function pageRange(model: Model, pages: number) {
	if (pages === 0) return 'NO SPILL';
	return inDomain(model, pages) ? 'IN DOMAIN' : 'OUTSIDE RANGE';
}

const f1 = (n: number) => n.toFixed(1);
const f0 = (n: number) => Math.round(n).toLocaleString('en-US');

function table(head: string[], rows: string[][]) {
	return [
		`| ${head.join(' | ')} |`,
		`| ${head.map(() => '---').join(' | ')} |`,
		...rows.map((r) => `| ${r.join(' | ')} |`)
	].join('\n');
}

export function report(models: Model[] = (['C', 'B2', 'B1'] as const).map(loadModel)) {
	const [C, B2, B1] = models as [Model, Model, Model];
	const out: string[] = [];

	out.push('### Meter at route end (MiB), kill line 203');
	out.push(
		table(
			[
				'route',
				'linear',
				'meter low',
				'meter central',
				'meter high',
				'over at low',
				'over at central',
				'over at high'
			],
			routes.map((r) => [
				r.name,
				f1(r.linear),
				f1(meterMiB(r, 'low')),
				f1(meterMiB(r, 'central')),
				f1(meterMiB(r, 'high')),
				f1(remainingMiB(r, 'low', 0)),
				f1(remainingMiB(r, 'central', 0)),
				f1(remainingMiB(r, 'high', 0))
			])
		)
	);

	out.push('### After the 4 MiB stack shrink alone (remaining over the line, MiB)');
	out.push(
		table(
			[
				'route',
				'saving at 4',
				'low',
				'central',
				'high',
				'floor-256 saving',
				'floor-256 high'
			],
			routes.map((r) => [
				r.name,
				f1(r.save4),
				f1(remainingMiB(r, 'low', r.save4)),
				f1(remainingMiB(r, 'central', r.save4)),
				f1(remainingMiB(r, 'high', r.save4)),
				r.floor4 === undefined ? 'NOT RUN' : f1(r.floor4),
				r.floor4 === undefined ? 'NOT RUN' : f1(remainingMiB(r, 'high', r.floor4))
			])
		)
	);

	out.push('### Routes that need a spill after the shrink, predicted added store time');
	const spill: string[][] = [];
	for (const r of routes) {
		for (const s of scenarios) {
			const mib = remainingMiB(r, s, r.save4);
			const pages = spillPages(mib);
			if (pages === 0) continue;
			spill.push([
				r.name,
				s,
				f1(mib),
				f0(pages),
				pageRange(C, pages),
				f0(storeMsPerPage(C) * pages),
				f0(storeMsPerPage(B2) * pages),
				f0(storeMsPerPage(B1) * pages),
				f0(spillReadMs * pages),
				f0((spillReadMs + C.coefficients.writeMs) * pages)
			]);
		}
	}
	out.push(
		spill.length === 0
			? 'No route needs a spill.'
			: table(
					[
						'route',
						'meter',
						'spill MiB',
						'pages',
						'range (C)',
						'C ms',
						'B2 ms',
						'B1 ms',
						'768 read-only ms',
						'768 read + C write ms'
					],
					spill
				)
	);

	out.push('### Worst remaining excess (MiB) and spill pages by saving');
	out.push(
		table(
			['scenario', 'saving 20', 'saving 28', 'saving 35'],
			scenarios.map((s) => [
				s,
				...[20, 28, 35].map((saving) => {
					const worst = routes
						.map((r) => ({ r, mib: remainingMiB(r, s, saving) }))
						.reduce((a, b) => (b.mib > a.mib ? b : a));
					return `${f1(worst.mib)} (${worst.r.name}), ${f0(spillPages(worst.mib))} pages`;
				})
			])
		)
	);
	const slopeWorst = Math.max(...routes.map((r) => remainingMiB(r, 'high', r.save4, 0.77)));
	out.push(
		`Meter slope 0.77 (S7 C1 low end) at the high scenario, 4 MiB alone: worst ${f1(slopeWorst)} MiB, ${f0(spillPages(slopeWorst))} pages.`
	);

	out.push('### Break-even spill for a 15 s request (base taken as the model intercept)');
	out.push(
		table(
			[
				'model',
				'base ms',
				'store ms per page',
				'break-even pages',
				'break-even MiB',
				'domain reads',
				'domain writes'
			],
			[C, B2, B1].map((m) => [
				m.name,
				f0(m.coefficients.baseMs),
				storeMsPerPage(m).toFixed(4),
				f0(breakEvenPages(m)),
				f0(breakEvenPages(m) / PAGES_PER_MIB),
				`${m.reads[0]} to ${m.reads[1]}`,
				`${m.writes[0]} to ${m.writes[1]}`
			])
		)
	);

	return out.join('\n\n');
}

if (import.meta.main) {
	console.log(report());
}
