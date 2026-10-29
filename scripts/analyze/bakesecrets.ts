import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { findInImage, type MemoryImage } from '../../src/bake.ts';
import { parseRows, readRaw, resultsRoot, stats, writeSummary, type Row } from './lib.ts';

// bake secrets summary from bake-secrets.ts rows: what a baked heap holds, whether a replay site's
// key and salt win, whether replayed instances share random state, and what the rekey step costs
// usage: analyzeBakeSecrets('boot/replay-852')

export type Form = 'raw' | 'base64' | 'hex';

export interface Secret {
	name: string;
	bytes: Uint8Array;
	/** what the run expects: a scan proves absence, presence, or only reports */
	expect: 'present' | 'absent' | 'info';
}

export interface Hit {
	secret: string;
	form: Form;
	/** the exact byte string searched, as text (a base64 or hex rendering, or the raw text) */
	needle: string;
	count: number;
	offsets: number[];
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');
const keep = 5;

/**
 * Every byte string a secret can appear as in memory: the bytes themselves, base64 (standard and
 * URL alphabets, padding removed) at each of the three alignments a 3 byte group can start at, and
 * hex in both cases. The partial base64 characters at either end are dropped, since their bits
 * depend on the neighbouring bytes.
 */
export function secretForms(bytes: Uint8Array): { form: Form; needle: string }[] {
	if (!bytes.length) throw new TypeError('a secret needs at least one byte');
	const seen = new Set<string>();
	const out: { form: Form; needle: string }[] = [];
	const add = (form: Form, needle: string) => {
		if (!needle.length || seen.has(needle)) return;
		seen.add(needle);
		out.push({ form, needle });
	};
	add('raw', text(bytes));
	for (let offset = 0; offset < 3; offset++) {
		const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
		const lead = [0, 2, 3][offset]!;
		for (const alphabet of ['base64', 'base64url'] as const) {
			let encoded = padded.toString(alphabet).replace(/=+$/, '');
			if (padded.length % 3) encoded = encoded.slice(0, -1);
			add('base64', encoded.slice(lead));
		}
	}
	const hex = Buffer.from(bytes).toString('hex');
	add('hex', hex);
	add('hex', hex.toUpperCase());
	return out;
}

const latin1 = (needle: string) => Uint8Array.from(Buffer.from(needle, 'latin1'));

function collect(
	secrets: Secret[],
	search: (needles: Uint8Array[]) => { needle: number; offset: number }[]
): Hit[] {
	const plan = secrets.flatMap((secret) =>
		secretForms(secret.bytes).map((entry) => ({ secret: secret.name, ...entry }))
	);
	const found = search(plan.map((entry) => latin1(entry.needle)));
	return plan.map((entry, index) => {
		const offsets = found.filter((match) => match.needle === index).map((m) => m.offset);
		return {
			secret: entry.secret,
			form: entry.form,
			needle: entry.needle.length > 12 ? `${entry.needle.length} characters` : entry.needle,
			count: offsets.length,
			offsets: offsets.slice(0, keep)
		};
	});
}

/** every form of every secret searched in the image pages; offsets are memory offsets */
export const scanImage = (image: MemoryImage, secrets: Secret[]): Hit[] =>
	collect(secrets, (needles) => findInImage(image, needles));

/** the same search over flat bytes, such as a baked module; offsets are file offsets */
export const scanBytes = (bytes: Uint8Array, secrets: Secret[]): Hit[] =>
	collect(secrets, (needles) => {
		const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
		return needles.flatMap((needle, index) => {
			const offsets: number[] = [];
			for (let at = buffer.indexOf(needle); at >= 0; at = buffer.indexOf(needle, at + 1))
				offsets.push(at);
			return offsets.map((offset) => ({ needle: index, offset }));
		});
	});

export interface SecretResult {
	secret: string;
	expect: Secret['expect'];
	forms: Record<Form, number>;
	total: number;
	/** present means found in at least one form, absent means found in none */
	found: boolean;
	/** a pass is found for `present`, not found for `absent`, and always for `info` */
	pass: boolean;
	first?: { form: Form; offset: number };
}

/** collapses the per-form hits of a scan into one verdict per secret */
export function judge(hits: Hit[], secrets: Secret[]): SecretResult[] {
	return secrets.map((secret) => {
		const mine = hits.filter((hit) => hit.secret === secret.name);
		const forms: Record<Form, number> = { raw: 0, base64: 0, hex: 0 };
		for (const hit of mine) forms[hit.form] += hit.count;
		const total = forms.raw + forms.base64 + forms.hex;
		const first = mine.find((hit) => hit.count > 0);
		return {
			secret: secret.name,
			expect: secret.expect,
			forms,
			total,
			found: total > 0,
			pass: secret.expect === 'info' || (secret.expect === 'present') === total > 0,
			first: first && { form: first.form, offset: first.offsets[0]! }
		};
	});
}

/** pages and bytes that differ between two images of one memory size */
export function diffImages(a: MemoryImage, b: MemoryImage) {
	const index = (image: MemoryImage) => new Map(image.pages.map((page, i) => [page, i]));
	const left = index(a);
	const right = index(b);
	const pageBytes = 65536;
	let onlyA = 0;
	let onlyB = 0;
	let both = 0;
	let bytesDifferInBoth = 0;
	let pagesDifferInBoth = 0;
	for (const [page, i] of left) {
		const j = right.get(page);
		if (j === undefined) {
			onlyA++;
			continue;
		}
		both++;
		let differ = 0;
		const x = a.data.subarray(i * pageBytes, (i + 1) * pageBytes);
		const y = b.data.subarray(j * pageBytes, (j + 1) * pageBytes);
		for (let k = 0; k < pageBytes; k++) if (x[k] !== y[k]) differ++;
		if (differ) pagesDifferInBoth++;
		bytesDifferInBoth += differ;
	}
	for (const page of right.keys()) if (!left.has(page)) onlyB++;
	return {
		memoryBytesEqual: a.byteLength === b.byteLength,
		pagesA: a.pages.length,
		pagesB: b.pages.length,
		pagesOnlyA: onlyA,
		pagesOnlyB: onlyB,
		pagesBoth: both,
		pagesDifferInBoth,
		bytesDifferInBoth,
		bytesInOnlyPages: (onlyA + onlyB) * pageBytes,
		bytesDifferTotal: bytesDifferInBoth + (onlyA + onlyB) * pageBytes
	};
}

// #region sweep

export type SweepClass = 'hex32' | 'hex40' | 'hex64' | 'base64url' | 'base64';

export interface SweepFinding {
	class: SweepClass;
	length: number;
	/** Shannon entropy in bits per character */
	entropy: number;
	/** how many times this exact string occurs in the heap */
	count: number;
	/** first 16 hex digits of the string's SHA-256, so a value can be matched without storing it */
	sha16: string;
	/** the 14 characters before the first occurrence, unprintable bytes as a dot, long runs as a star */
	before: string;
}

/** Shannon entropy of a string in bits per character */
export function entropy(value: string): number {
	const counts = new Map<string, number>();
	for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
	return bits;
}

/** the entropy a string of this length drawn uniformly from `symbols` symbols is expected to have */
export const expectedEntropy = (length: number, symbols = 64) =>
	Math.log2(symbols) - (symbols - 1) / (2 * length * Math.LN2);

const sweepPatterns: [SweepClass, RegExp][] = [
	['hex32', /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/g],
	['hex40', /(?<![0-9A-Za-z])[0-9a-f]{40}(?![0-9A-Za-z])/g],
	['hex64', /(?<![0-9A-Za-z])[0-9a-f]{64}(?![0-9A-Za-z])/g],
	['base64url', /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43,}(?![A-Za-z0-9_-])/g],
	[
		'base64',
		/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9]*[+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g
	]
];

/**
 * Every string in a heap that is shaped like a secret: 32, 40 and 64 character lowercase hex
 * (session ids, SHA-1 and SHA-256 digests), and runs of 43 or more base64url or 40 or more base64
 * characters (base64 only when a plus or a slash is in the run) whose entropy is within `margin` bits per character of what random characters give,
 * so identifiers, paths and prose drop out. One finding per distinct string, with its count and
 * its SHA-256 prefix rather than the value.
 */
export function sweepBytes(bytes: Uint8Array, margin = 0.35): SweepFinding[] {
	const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
	const found = new Map<string, SweepFinding>();
	for (const [name, pattern] of sweepPatterns) {
		for (const match of text.matchAll(pattern)) {
			const value = match[0];
			const bits = entropy(value);
			const prose = name === 'base64url' || name === 'base64';
			if (prose && bits < expectedEntropy(value.length) - margin) continue;
			const key = `${name}:${value}`;
			const seen = found.get(key);
			if (seen) {
				seen.count++;
				continue;
			}
			const at = match.index!;
			found.set(key, {
				class: name,
				length: value.length,
				entropy: Math.round(bits * 100) / 100,
				count: 1,
				sha16: createHash('sha256').update(value).digest('hex').slice(0, 16),
				before: text
					.slice(Math.max(0, at - 14), at)
					.replace(/[^\x20-\x7e]/g, '.')
					.replace(/[A-Za-z0-9_-]{8,}/g, '*')
			});
		}
	}
	return [...found.values()];
}

/** strings found in both heaps (by class and digest) against those only one holds */
export function compareSweeps(a: SweepFinding[], b: SweepFinding[]) {
	const id = (finding: SweepFinding) => `${finding.class}:${finding.sha16}`;
	const inB = new Set(b.map(id));
	const inA = new Set(a.map(id));
	return {
		shared: a.filter((finding) => inB.has(id(finding))),
		onlyA: a.filter((finding) => !inB.has(id(finding))),
		onlyB: b.filter((finding) => !inA.has(id(finding)))
	};
}

/** findings grouped by class, length and the text before them, largest group first */
export function clusterSweep(findings: SweepFinding[]) {
	const groups = new Map<string, SweepFinding[]>();
	for (const finding of findings) {
		const key = `${finding.class}\0${finding.length}\0${finding.before}`;
		groups.set(key, [...(groups.get(key) ?? []), finding]);
	}
	return [...groups]
		.map(([key, list]) => {
			const [cls, length, before] = key.split('\0');
			return {
				class: cls as SweepClass,
				length: Number(length),
				before: before!,
				distinct: list.length,
				occurrences: list.reduce((n, finding) => n + finding.count, 0)
			};
		})
		.sort((x, y) => y.distinct - x.distinct);
}

// #endregion

const by = <T>(rows: T[], key: (row: T) => string) => {
	const groups = new Map<string, T[]>();
	for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
	return groups;
};

const median = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

const numbers = (rows: Row[], field: string) =>
	rows.map((row) => row[field]).filter((value): value is number => typeof value === 'number');

const statsOf = (rows: Row[], field: string) => {
	const values = numbers(rows, field);
	return values.length ? stats(values) : undefined;
};

const pairwiseDistinct = (values: unknown[]) => new Set(values).size === values.length;

/** T1: one row per scanned target, a pass when every secret came out as expected */
export function summarizeScans(rows: Row[]) {
	const scans = rows.filter((row) => row.kind === 'scan');
	return scans.map((row) => ({
		tag: row.tag,
		role: row.role,
		target: row.target,
		bytes: row.targetBytes,
		pass: (row.results as SecretResult[]).every((result) => result.pass),
		failed: (row.results as SecretResult[])
			.filter((result) => !result.pass)
			.map((result) => result.secret),
		results: row.results
	}));
}

/**
 * T2: per rekey variant and phase (before any request, after the first render), the key and salt
 * each replayed instance used, and where its tokens validate: in a reference booted with the
 * replaying site's key and salt, and in one booted with the key and salt the image was baked with.
 */
export function summarizeRekey(rows: Row[]) {
	const replays = rows.filter((row) => row.kind === 'replay' && row.test === 'T2');
	const references = rows.filter((row) => row.kind === 'reference');
	const validations = references.flatMap((reference) =>
		(reference.validations as Row[]).map((entry): Row => ({
			...entry,
			config: reference.config
		}))
	);
	const hashes = (config: string) =>
		new Set(
			references.filter((row) => row.config === config).map((row) => row.permissionsHash)
		);
	const hashIs = (value: string) =>
		hashes('real').has(value) ? 'real' : hashes('bake').has(value) ? 'bake' : 'other';
	return [...by(replays, (row) => `${row.via}:${row.variant}`)].map(([name, group]) => {
		const [via, variant] = name.split(':') as [string, string];
		const phase = (which: 'pre' | 'post') => {
			const valid = (config: string) =>
				validations.filter(
					(entry) =>
						entry.variant === variant &&
						entry.via === via &&
						entry.phase === which &&
						entry.config === config
				);
			const unique = (field: string) => [...new Set(group.map((row) => row[which][field]))];
			return {
				keyIs: unique('keyIs'),
				saltIs: unique('saltIs'),
				sessionIdIsBaked: unique('sessionIdIsBaked'),
				tokensDistinct: unique('token').length,
				validInReal: valid('real').filter((entry) => entry.valid).length,
				testedInReal: valid('real').length,
				validInBake: valid('bake').filter((entry) => entry.valid).length,
				testedInBake: valid('bake').length
			};
		};
		return {
			variant,
			via,
			n: group.length,
			pre: phase('pre'),
			post: phase('post'),
			rekeyMs: statsOf(group, 'rekeyMs'),
			rendered: group.every((row) => row.status === 200),
			renderShas: [...new Set(group.map((row) => row.renderSha256))],
			permissionsHashIs: [...new Set(group.map((row) => hashIs(row.permissionsHash)))]
		};
	});
}

/** T3: first random values in each replayed instance, per variant */
export function summarizeRng(rows: Row[]) {
	const replays = rows.filter((row) => row.kind === 'replay' && row.test === 'T3');
	return [...by(replays, (row) => row.variant)].map(([variant, group]) => {
		const lcg = group.map((row) => String(row.uniqidMore).split('.')[1]);
		return {
			variant,
			n: group.length,
			mtRand: group.map((row) => row.mtRand),
			mtRandDistinct: pairwiseDistinct(group.map((row) => row.mtRand)),
			uniqidDistinct: pairwiseDistinct(group.map((row) => row.uniqid)),
			lcgDistinct: pairwiseDistinct(lcg),
			randomIntDistinct: pairwiseDistinct(group.map((row) => row.randomInt)),
			firstEqualsBakeContinuation: group.map((row) => row.mtRand === row.bakeNextMtRand)
		};
	});
}

/** arms: first-context open plus first render, per arm, against the plain boot of the same round */
export function summarizeArms(rows: Row[]) {
	const arms = rows.filter((row) => row.kind === 'arm');
	const plain = arms.filter((row) => row.arm === 'plain');
	const base = median(numbers(plain, 'totalMs'));
	return [...by(arms, (row) => row.arm)].map(([arm, group]) => {
		const total = statsOf(group, 'totalMs');
		return {
			arm,
			n: group.length,
			totalMs: total,
			openMs: statsOf(group, 'openMs'),
			rekeyMs: statsOf(group, 'rekeyMs'),
			firstRenderMs: statsOf(group, 'firstRenderMs'),
			compileMs: statsOf(group, 'compileMs'),
			savedVsPlainMs: total && base - total.median!,
			savedVsPlainPercent: total && ((base - total.median!) / base) * 100,
			renderShas: [...new Set(group.map((row) => row.firstSha256))],
			errors: group.filter((row) => row.error).length
		};
	});
}

/** a call into the host that the bridge carries: EM_ASM blocks, async imports and the cfw functions */
export const isBridgeCall = (name: string) =>
	/emscripten_asm_const|__asyncjs__/.test(name) || name.startsWith('Module.cfw');

const censusPhases = ['open', 'replay', 'idle', 'rekey', 'request', 'bridge-probe', 'stack-probe'];

/**
 * Host calls per phase of a replay, from the census rows. A harness call is one the replaying
 * script made itself (the recorded init block); a module call is one the wasm made. Calls before
 * the first PHP run are the `calls` field, the phases after it are `callsByPhase`.
 */
export function summarizeCensus(rows: Row[]) {
	const census = rows.filter((row) => row.kind === 'census');
	const sum = (calls: Record<string, number> | undefined, keep: (name: string) => boolean) =>
		Object.entries(calls ?? {})
			.filter(([name]) => keep(name))
			.reduce((n, [, count]) => n + count, 0);
	const harness = (name: string) => name.startsWith('harness:');
	return [...by(census, (row) => row.via)].map(([via, group]) => {
		const totals = (row: Row) => {
			const out: Record<string, number> = {};
			for (const calls of Object.values(row.calls as Record<string, Record<string, number>>))
				for (const [name, count] of Object.entries(calls))
					out[name] = (out[name] ?? 0) + count;
			return out;
		};
		const before = totals(group[0]!);
		const phases = (name: string) =>
			group.map((row) => (row.callsByPhase as Record<string, Record<string, number>>)[name]);
		const handles = group.map((row) => row.handlesAfterReplay);
		const only = (list: unknown[]) => [...new Set(list.map((value) => JSON.stringify(value)))];
		return {
			via,
			n: group.length,
			beforeFirstPhp: {
				harnessCalls: sum(before, harness),
				moduleCalls: sum(before, (name) => !harness(name)),
				moduleBridgeCalls: sum(before, (name) => !harness(name) && isBridgeCall(name)),
				sameInEveryRun: new Set(group.map((row) => JSON.stringify(totals(row)))).size === 1,
				names: before
			},
			byPhase: Object.fromEntries(
				censusPhases.map((name) => {
					const calls = phases(name).filter(Boolean) as Record<string, number>[];
					const first = calls[0];
					return [
						name,
						first && {
							runs: calls.length,
							bridgeCalls: sum(first, (call) => !harness(call) && isBridgeCall(call)),
							runtimeCalls: sum(
								first,
								(call) => !harness(call) && !isBridgeCall(call)
							),
							harnessCalls: sum(first, harness),
							bridgeByName: Object.fromEntries(
								Object.entries(first).filter(([call]) => isBridgeCall(call))
							)
						}
					];
				})
			),
			handleTables: only(
				handles.map((h) => h.handles.map((x: Row) => `${x.id}:${x.is}`).join(' '))
			),
			everyHandleIsRootOrSealed: handles.every((h) =>
				h.handles.every(
					(x: Row) => x.is === 'cfwRoot' || String(x.is).startsWith('sealed:')
				)
			),
			root: only(
				handles.map((h) => ({
					frozen: h.rootFrozen,
					prototypeNull: h.rootPrototypeNull,
					keys: h.rootKeys,
					isGlobalThis: h.rootIsGlobalThis
				}))
			),
			bridgeProbe: only(group.map((row) => row.bridgeProbe)),
			stackGlobals: only(group.map((row) => row.stackGlobals)),
			deepRecursion: only(
				group.map((row) => row.deepRecursion?.thrown?.split('\n')[0] ?? row.deepRecursion)
			),
			renderShas: [...new Set(group.map((row) => row.renderSha256))]
		};
	});
}

/** the sweep rows: counts per image, what two independent bakes share, and what only one holds */
export function summarizeSweep(rows: Row[]) {
	const compare = rows.find((row) => row.kind === 'sweepCompare');
	const perBake = rows.filter((row) => row.kind === 'sweepOnlyLeft');
	return {
		images: rows
			.filter((row) => row.kind === 'sweep')
			.map(({ tag, bytes, distinct, occurrences, byClass, known }) => ({
				tag,
				bytes,
				distinct,
				occurrences,
				byClass,
				known
			})),
		compare,
		perBake: perBake.map(({ class: cls, length, entropy, count, sha16, before, known }) => ({
			class: cls,
			length,
			entropy,
			count,
			sha16,
			before,
			known
		})),
		perBakeUnexplained: perBake.filter((row) => !row.known).length
	};
}

export function summarizeBakeSecrets(rows: Row[]) {
	const environment = rows.find((row) => row.kind === 'environment');
	const interpreters = rows.filter((row) => row.interp);
	const digests = new Set(interpreters.map((row) => row.interp.wasmSha256));
	const glues = new Set(interpreters.map((row) => row.interp.glueSha256));
	const checks = rows.filter((row) => row.kind === 'interpCheck');
	return {
		environment,
		interpreter: {
			rows: interpreters.length,
			wasmSha256: [...digests],
			glueSha256: [...glues],
			unchanged: checks.length > 0 && checks.every((row) => row.same)
		},
		pin: rows.find((row) => row.kind === 'pin'),
		captures: rows.filter((row) => row.kind === 'capture'),
		bakes: rows.filter((row) => row.kind === 'bake'),
		scans: summarizeScans(rows),
		keying: rows.filter((row) => row.kind === 'keying'),
		...(rows.some((row) => row.kind === 'census') && { census: summarizeCensus(rows) }),
		...(rows.some((row) => row.kind === 'sweep') && { sweep: summarizeSweep(rows) }),
		rekey: summarizeRekey(rows),
		rng: summarizeRng(rows),
		diffs: rows.filter((row) => row.kind === 'diff'),
		arms: summarizeArms(rows),
		loadAverage1m: loadRange(rows)
	};
}

function loadRange(rows: Row[]) {
	const loads = rows
		.map((row) => row.load?.[0])
		.filter((v): v is number => typeof v === 'number');
	return loads.length ? { min: Math.min(...loads), max: Math.max(...loads) } : undefined;
}

export function analyzeBakeSecrets(set: string) {
	const root = resultsRoot(set);
	const files = [
		'mac-capture.jsonl',
		'mac-replay.jsonl',
		'mac-census.jsonl',
		'mac-sweep.jsonl',
		'mac-arms.jsonl'
	].filter((name) => existsSync(new URL(name, root)));
	const rows = files.flatMap((name) => parseRows(readRaw(root, name)));
	writeSummary(root, summarizeBakeSecrets(rows));
}
