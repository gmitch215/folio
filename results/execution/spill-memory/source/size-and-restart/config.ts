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
	rung6b: {
		sizesMiB: number[];
		putMiB: number;
		armMiB: number;
		extentPages: number;
		repeats: number;
		holdMs: number;
		tailMs: number;
	};
	rung6c: {
		repeats: number;
		holdMs: number;
		minutes: number[];
		restartMib: number;
		smallMib: number;
		smallRowBytes: number;
		extentPages: number;
		secondMib: number;
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

// rungs 6b and 6c stay out of the default list: 6b fits the row cap alone, 6c needs a raised one
export const RUNGS = [5, 6, 4, 1, 7, 2, 3] as const;
export type Rung = (typeof RUNGS)[number] | '6b' | '6c';
export const ALL_RUNGS: readonly Rung[] = [5, 6, '6b', '6c', 4, 1, 7, 2, 3];

export type Group = 'ladder' | 'spill' | 'mem';
export const GROUPS: readonly Group[] = ['ladder', 'spill', 'mem'];
export const groupOf = (rung: Rung): Group =>
	rung === 7 ? 'mem' : rung === '6b' || rung === '6c' ? 'spill' : 'ladder';

// the spill script holds only spill classes, so rung 6 objects cannot share a class with 6b or 6c
export const LADDER_CLASSES = [
	'Executor',
	'Owner',
	'Store',
	'Burner',
	'SpillSql',
	'SpillPut',
	'SpillNone'
];
// one class per arm: a class keeps the previous object's memory for about a minute
export const SPILL_CLASSES = [
	'Size0',
	'Size1',
	'Size2',
	'Size3',
	'Size4',
	'PutOne',
	'ReadBack',
	'Drop',
	'CtlSql',
	'CtlPut',
	'Restart',
	'CtlRestart',
	'SmallRows',
	'SmallExt',
	'CtlSmall',
	'SecOwn',
	'CtlSec',
	'SecExec',
	'CtlSecExec'
];
// the idle control whose reading is subtracted from an arm's class
export const CONTROL_OF: Record<string, string> = {
	Size0: 'CtlSql',
	Size1: 'CtlSql',
	Size2: 'CtlSql',
	Size3: 'CtlSql',
	Size4: 'CtlSql',
	ReadBack: 'CtlSql',
	Drop: 'CtlSql',
	PutOne: 'CtlPut',
	Restart: 'CtlRestart',
	SmallRows: 'CtlSmall',
	SmallExt: 'CtlSmall',
	SecOwn: 'CtlSec',
	SecExec: 'CtlSecExec'
};
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
export const GROUP_CLASSES: Record<Group, string[]> = {
	ladder: LADDER_CLASSES,
	spill: SPILL_CLASSES,
	mem: MEM_CLASSES
};
export const GROUP_WORKER: Record<Group, string> = {
	ladder: 'worker-ladder.mjs',
	spill: 'worker-ladder.mjs',
	mem: 'worker-mem.mjs'
};
// spill and ladder classes bind to their upper-case name unless listed in LADDER_BINDINGS
export const bindingOf = (group: Group, cls: string) =>
	group === 'mem' ? cls : (LADDER_BINDINGS[cls] ?? cls.toUpperCase());

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
	rung6b: {
		sizesMiB: [16, 32, 64, 128, 256],
		putMiB: 128,
		armMiB: 64,
		extentPages: 16,
		repeats: 3,
		holdMs: 70000,
		tailMs: 130000
	},
	rung6c: {
		repeats: 2,
		holdMs: 70000,
		minutes: [5, 10, 15, 20],
		restartMib: 64,
		smallMib: 16,
		smallRowBytes: 4096,
		extentPages: 16,
		secondMib: 64
	},
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
	rung6b: {
		sizesMiB: [1, 2],
		putMiB: 2,
		armMiB: 2,
		extentPages: 4,
		repeats: 2,
		holdMs: 5,
		tailMs: 5
	},
	rung6c: {
		repeats: 2,
		holdMs: 5,
		minutes: [0.01, 0.02],
		restartMib: 2,
		smallMib: 1,
		smallRowBytes: 4096,
		extentPages: 4,
		secondMib: 2
	},
	rung7: { sizesMiB: [2, 4], repeats: 2, holdMs: 5, touchChunkMiB: 2, bare: 2 },
	caps: { rows: 8000, requests: 1500, planningDailyRows: 80000 },
	assumptions: { schemaRowsPerTable: 2, readyPolls: 1 }
};

export const KIB = 1024;
export const MIB = 1048576;
export const PAGE = 65536;
