export interface Config {
	name: string;
	rung1: { sizesKiB: number[]; n: number; repeats: number };
	rung2: { n: number; repeats: number; hint: string; coloProbe: boolean };
	rung3: { seq: number; rpcSeq: number; fan: number; repeats: number };
	rung4: { ladder: number[]; targetsMs: number[]; repeats: number; noops: number };
	rung5: { sizeKiB: number; read: number; rmw: number[]; repeats: number };
	rung6: {
		mib: number;
		extentPages: number;
		repeats: number;
		holdMs: number;
		pageRowArm: boolean;
	};
	rung7: {
		sizesMiB: number[];
		repeats: number;
		holdMs: number;
		touchChunkMiB: number;
		bare: number;
	};
	caps: { rows: number; requests: number; planningDailyRows: number };
	assumptions: { schemaRowsPerTable: number; readyPolls: number };
}

export const RUNGS = [5, 6, 4, 1, 7, 2, 3] as const;
export type Rung = (typeof RUNGS)[number];

// rung 7 runs in its own script; the others share one
export const LADDER_CLASSES = [
	'Executor',
	'Owner',
	'Store',
	'Burner',
	'SpillSql',
	'SpillPut',
	'SpillNone'
];
export const LADDER_BINDINGS: Record<string, string> = {
	Executor: 'EXEC',
	Owner: 'OWN',
	Store: 'STORE',
	Burner: 'BURN',
	SpillSql: 'SPILLSQL',
	SpillPut: 'SPILLPUT',
	SpillNone: 'SPILLNONE'
};
export const MEM_CLASSES = Array.from({ length: 26 }, (_, i) => `M${String(i).padStart(2, '0')}`);

export const LIVE: Config = {
	name: 'live',
	rung1: { sizesKiB: [1, 4, 16, 64, 256], n: 16, repeats: 20 },
	rung2: { n: 200, repeats: 3, hint: 'enam', coloProbe: true },
	rung3: { seq: 1000, rpcSeq: 33, fan: 16, repeats: 2 },
	rung4: {
		ladder: [1e6, 4e6, 16e6, 32e6, 64e6, 128e6],
		targetsMs: [50, 200],
		repeats: 5,
		noops: 3
	},
	rung5: { sizeKiB: 64, read: 200, rmw: [50, 200], repeats: 3 },
	rung6: { mib: 64, extentPages: 16, repeats: 3, holdMs: 70000, pageRowArm: false },
	rung7: { sizesMiB: [64, 128], repeats: 6, holdMs: 75000, touchChunkMiB: 16, bare: 2 },
	caps: { rows: 8000, requests: 1500, planningDailyRows: 80000 },
	assumptions: { schemaRowsPerTable: 2, readyPolls: 1 }
};

export const TINY: Config = {
	name: 'tiny',
	rung1: { sizesKiB: [1, 4], n: 3, repeats: 2 },
	rung2: { n: 4, repeats: 2, hint: 'enam', coloProbe: false },
	rung3: { seq: 5, rpcSeq: 3, fan: 4, repeats: 2 },
	rung4: { ladder: [1e3, 1e4, 1e5], targetsMs: [50, 200], repeats: 2, noops: 2 },
	rung5: { sizeKiB: 4, read: 6, rmw: [2, 5], repeats: 2 },
	rung6: { mib: 2, extentPages: 4, repeats: 2, holdMs: 5, pageRowArm: true },
	rung7: { sizesMiB: [2, 4], repeats: 2, holdMs: 5, touchChunkMiB: 2, bare: 2 },
	caps: { rows: 8000, requests: 1500, planningDailyRows: 80000 },
	assumptions: { schemaRowsPerTable: 2, readyPolls: 1 }
};

export const KIB = 1024;
export const MIB = 1048576;
export const PAGE = 65536;
