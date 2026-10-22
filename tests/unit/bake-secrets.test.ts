import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import {
	diffImages,
	judge,
	scanBytes,
	scanImage,
	secretForms,
	summarizeArms,
	summarizeBakeSecrets,
	summarizeRekey,
	summarizeRng,
	summarizeScans,
	type Secret
} from '../../scripts/analyze/bakesecrets.ts';
import type { Row } from '../../scripts/analyze/lib.ts';
import {
	phpString,
	REKEY_KEY_PHP,
	REKEY_MEMORY_PHP,
	REKEY_RNG_PHP,
	rekeyCode,
	variants
} from '../../scripts/probe/bake-rekey.ts';
import type { MemoryImage } from '../../src/bake.ts';

const page = 65536;
const encode = (value: string) => new TextEncoder().encode(value);
const secret = (name: string, value: string, expect: Secret['expect'] = 'absent'): Secret => ({
	name,
	bytes: encode(value),
	expect
});

const key = 'dXDyw2u9Rlft9sB7vqEsMnmfX8lztuV0diuGnweHtzL37L8ab-sA9Mq9WjTVqvXs_aBcDeFgHiJkLmNoP';

/** a one page image with `data` written at `at` */
function imageWith(at: number, data: Uint8Array, pageIndex = 3): MemoryImage {
	const bytes = new Uint8Array(page);
	bytes.set(data, at);
	return { byteLength: 8 * page, pages: [pageIndex], data: bytes };
}

test('secretForms lists the raw bytes, three base64 alignments in two alphabets, and hex in both cases', () => {
	const forms = secretForms(encode(key));
	const of = (form: string) => forms.filter((entry) => entry.form === form);
	expect(of('raw')).toEqual([{ form: 'raw', needle: key }]);
	expect(of('hex').map((entry) => entry.needle)).toEqual([
		Buffer.from(key).toString('hex'),
		Buffer.from(key).toString('hex').toUpperCase()
	]);
	expect(of('base64').length).toBeGreaterThanOrEqual(3);
	expect(of('base64').length).toBeLessThanOrEqual(6);
	expect(new Set(forms.map((entry) => entry.needle)).size).toBe(forms.length);
	expect(() => secretForms(new Uint8Array(0))).toThrow(TypeError);
});

test('a secret is found in base64 at every alignment, in either alphabet', () => {
	const target = encode(key);
	for (let lead = 0; lead < 6; lead++) {
		for (const alphabet of ['base64', 'base64url'] as const) {
			const around = Buffer.concat([randomBytes(lead + 4), target, randomBytes(7)]);
			const text = encode(around.toString(alphabet));
			const hits = scanBytes(text, [secret('key', key)]);
			const found = hits.filter((hit) => hit.count > 0);
			expect(found.length, `lead ${lead} ${alphabet}`).toBeGreaterThan(0);
			expect(found.every((hit) => hit.form === 'base64')).toBe(true);
		}
	}
});

test('scanBytes and scanImage find raw, hex and base64 forms and report offsets', () => {
	const hex = Buffer.from(key).toString('hex');
	const b64 = Buffer.from(key).toString('base64').replace(/=+$/, '');
	const bytes = new Uint8Array(4096);
	bytes.set(encode(key), 10);
	bytes.set(encode(hex), 200);
	bytes.set(encode(hex.toUpperCase()), 500);
	bytes.set(encode(b64), 900);
	bytes.set(encode(key), 2000);
	const secrets = [secret('key', key, 'present'), secret('other', 'zzzzzzzz-not-here', 'absent')];
	const flat = judge(scanBytes(bytes, secrets), secrets);
	expect(flat[0]).toMatchObject({
		secret: 'key',
		forms: { raw: 2, base64: 1, hex: 2 },
		total: 5,
		found: true,
		pass: true,
		first: { form: 'raw', offset: 10 }
	});
	expect(flat[1]).toMatchObject({ total: 0, found: false, pass: true });
	const image = imageWith(0, bytes, 5);
	const paged = judge(scanImage(image, secrets), secrets);
	expect(paged[0]!.total).toBe(5);
	expect(paged[0]!.first).toEqual({ form: 'raw', offset: 5 * page + 10 });
	const empty = judge(scanImage(imageWith(0, new Uint8Array(0)), secrets), secrets);
	expect(empty.map((result) => result.found)).toEqual([false, false]);
});

test('judge fails a present secret that is missing, an absent secret that is there, and never an info one', () => {
	const bytes = encode(`xx${key}xx`);
	const secrets = [
		secret('want', 'not-in-memory-at-all', 'present'),
		secret('leak', key, 'absent'),
		secret('look', key, 'info'),
		secret('nolook', 'missing-value', 'info')
	];
	const results = judge(scanBytes(bytes, secrets), secrets);
	expect(results.map((result) => result.pass)).toEqual([false, false, true, true]);
	expect(results[1]!.first).toEqual({ form: 'raw', offset: 2 });
});

test('a needle straddling a gap between image pages is not found, one across adjacent pages is', () => {
	const target = encode(key);
	const split = (pages: number[]): MemoryImage => {
		const data = new Uint8Array(2 * page);
		data.set(target.subarray(0, 30), page - 30);
		data.set(target.subarray(30), page);
		return { byteLength: 9 * page, pages, data };
	};
	const secrets = [secret('key', key, 'present')];
	expect(judge(scanImage(split([2, 3]), secrets), secrets)[0]!.found).toBe(true);
	expect(judge(scanImage(split([2, 5]), secrets), secrets)[0]!.found).toBe(false);
});

test('diffImages counts pages only in one image, and bytes that differ in the shared pages', () => {
	const make = (pages: number[], fill: (index: number) => number): MemoryImage => {
		const data = new Uint8Array(pages.length * page);
		pages.forEach((_, i) => data.fill(fill(i), i * page, (i + 1) * page));
		return { byteLength: 16 * page, pages, data };
	};
	const a = make([1, 2, 3], () => 7);
	const b = make([2, 3, 4], () => 7);
	b.data[page + 5] = 9;
	b.data[page + 6] = 9;
	expect(diffImages(a, b)).toEqual({
		memoryBytesEqual: true,
		pagesA: 3,
		pagesB: 3,
		pagesOnlyA: 1,
		pagesOnlyB: 1,
		pagesBoth: 2,
		pagesDifferInBoth: 1,
		bytesDifferInBoth: 2,
		bytesInOnlyPages: 2 * page,
		bytesDifferTotal: 2 + 2 * page
	});
	expect(diffImages(a, a).bytesDifferTotal).toBe(0);
});

test('summarizeScans passes a target only when every secret came out as expected', () => {
	const pass = { secret: 'K0', pass: true };
	const fail = { secret: 'K2', pass: false };
	const rows = [
		{
			kind: 'scan',
			tag: 'a',
			role: 'sentinel',
			target: 'image',
			targetBytes: 5,
			results: [pass]
		},
		{
			kind: 'scan',
			tag: 'a',
			role: 'sentinel',
			target: 'module',
			targetBytes: 6,
			results: [pass, fail]
		},
		{ kind: 'other' }
	];
	const summary = summarizeScans(rows);
	expect(summary.map((row) => row.pass)).toEqual([true, false]);
	expect(summary[1]!.failed).toEqual(['K2']);
});

test('summarizeRekey reports which key and salt each variant used and where its tokens validate', () => {
	const phase = (token: string, is: string, extra = {}) => ({
		token,
		keyIs: is,
		saltIs: is,
		sessionIdIsBaked: false,
		...extra
	});
	const replay = (variant: string, pre: Row, post: Row, hash = 'h-real') => ({
		kind: 'replay',
		test: 'T2',
		via: 'apply',
		variant,
		pre,
		post,
		status: 200,
		renderSha256: 'r',
		permissionsHash: hash
	});
	const reference = (config: string, valid: Record<string, boolean>, hash: string) => ({
		kind: 'reference',
		config,
		permissionsHash: hash,
		validations: Object.entries(valid).map(([key, ok]) => {
			const [variant, which] = key.split('/');
			return { variant, via: 'apply', phase: which, valid: ok };
		})
	});
	const rows = [
		replay('none', phase('a', 'bake'), phase('b', 'mixed', { keyIs: 'real' }), 'h-bake'),
		replay('none', phase('a', 'bake'), phase('b', 'mixed', { keyIs: 'real' }), 'h-bake'),
		replay('full', phase('c', 'real'), phase('c', 'real')),
		replay('full', phase('c', 'real'), phase('c', 'real')),
		reference(
			'real',
			{ 'none/pre': false, 'none/post': false, 'full/pre': true, 'full/post': true },
			'h-real'
		),
		reference(
			'bake',
			{ 'none/pre': true, 'none/post': false, 'full/pre': false, 'full/post': false },
			'h-bake'
		)
	];
	const [none, full] = summarizeRekey(rows);
	expect(none).toMatchObject({ variant: 'none', n: 2, permissionsHashIs: ['bake'] });
	expect(none!.pre).toMatchObject({
		keyIs: ['bake'],
		saltIs: ['bake'],
		validInReal: 0,
		testedInReal: 1,
		validInBake: 1,
		testedInBake: 1
	});
	expect(none!.post).toMatchObject({ keyIs: ['real'], saltIs: ['mixed'], validInBake: 0 });
	expect(full).toMatchObject({ variant: 'full', permissionsHashIs: ['real'], rendered: true });
	expect(full!.post).toMatchObject({
		keyIs: ['real'],
		tokensDistinct: 1,
		validInReal: 1,
		testedInReal: 1,
		validInBake: 0,
		testedInBake: 1
	});
});

test('summarizeRng finds repeated values and compares with the bake process continuation', () => {
	const row = (variant: string, mt: number, lcg: string, next: number) => ({
		kind: 'replay',
		test: 'T3',
		variant,
		mtRand: mt,
		uniqid: `u${mt}${lcg}`,
		uniqidMore: `0000.${lcg}`,
		randomInt: mt + 1000,
		bakeNextMtRand: next
	});
	const rows = [
		row('none', 5, '111', 5),
		row('none', 5, '111', 5),
		row('full', 1, '1', 5),
		row('full', 2, '2', 5)
	];
	const [none, full] = summarizeRng(rows);
	expect(none).toMatchObject({
		variant: 'none',
		n: 2,
		mtRandDistinct: false,
		lcgDistinct: false
	});
	expect(none!.firstEqualsBakeContinuation).toEqual([true, true]);
	expect(full).toMatchObject({
		mtRandDistinct: true,
		lcgDistinct: true,
		randomIntDistinct: true
	});
});

test('summarizeArms measures each arm against the plain boot median', () => {
	const row = (arm: string, totalMs: number, extra = {}) => ({
		kind: 'arm',
		arm,
		totalMs,
		openMs: totalMs - 10,
		firstRenderMs: 10,
		firstSha256: 's',
		...extra
	});
	const rows = [
		row('plain', 1000),
		row('plain', 1200),
		row('plain', 1100),
		row('baked', 400),
		row('baked', 500),
		row('baked', 450, { rekeyMs: 5, error: 'x' })
	];
	const [plain, baked] = summarizeArms(rows);
	expect(plain).toMatchObject({ arm: 'plain', n: 3, savedVsPlainMs: 0 });
	expect(baked).toMatchObject({ arm: 'baked', n: 3, errors: 1 });
	expect(baked!.savedVsPlainMs).toBe(650);
	expect(baked!.savedVsPlainPercent).toBeCloseTo((650 / 1100) * 100, 6);
	expect(baked!.rekeyMs).toMatchObject({ n: 1, median: 5 });
});

test('summarizeBakeSecrets records the interpreter digests and whether the pin held', () => {
	const interp = { wasmSha256: 'a', glueSha256: 'b' };
	const summary = summarizeBakeSecrets([
		{ kind: 'environment', machine: 'm', interp, load: [1, 2, 3] },
		{ kind: 'interpCheck', same: true, interp, load: [3, 2, 1] }
	]);
	expect(summary.interpreter).toEqual({
		rows: 2,
		wasmSha256: ['a'],
		glueSha256: ['b'],
		unchanged: true
	});
	expect(summary.loadAverage1m).toEqual({ min: 1, max: 3 });
	expect(summarizeBakeSecrets([]).interpreter.unchanged).toBe(false);
	expect(summarizeBakeSecrets([]).loadAverage1m).toBeUndefined();
});

test('phpString quotes any text as a single-quoted PHP literal', () => {
	expect(phpString('abc-_')).toBe("'abc-_'");
	expect(phpString("it's \\ $x")).toBe("'it\\'s \\\\ $x'");
});

test('rekeyCode joins the chosen parts and writes the salt once as a literal', () => {
	const salt = "s$&'\\x";
	const full = rekeyCode(salt, variants.full!);
	expect(full).toContain(`->call(Settings::getInstance(), ${phpString(salt)});`);
	expect(full).not.toContain('__SALT__');
	for (const part of [REKEY_KEY_PHP, REKEY_MEMORY_PHP, REKEY_RNG_PHP])
		expect(full).toContain(part);
	expect(rekeyCode(salt, variants.none!)).toBe('');
	expect(rekeyCode(salt, variants.key!)).toBe(REKEY_KEY_PHP);
	const saltOnly = rekeyCode(salt, variants.salt!);
	expect(saltOnly).toContain('hash_salt');
	expect(saltOnly).not.toContain('reset()');
	expect(rekeyCode(salt, variants['salt+key']!)).not.toContain('mt_srand');
	expect(Object.values(variants.full!).every(Boolean)).toBe(true);
});
