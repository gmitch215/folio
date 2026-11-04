import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
	buildMiniz,
	buildOutputSubjects,
	buildSubjects
} from '../../scripts/research/affine-build.ts';
import { groundTruth } from '../../scripts/research/certify-ground.ts';
import { build, mutants } from '../../scripts/research/split-sensitivity.ts';
import { predictEnd, probeAffine } from '../../src/affine.ts';
import {
	foldCertified,
	installPrefill,
	reconstructCertified,
	serveCertified,
	shareCertified
} from '../../src/certified.ts';
import {
	certifyStream,
	guardInput,
	verifyCertificate,
	type CertificateRefusal,
	type StreamCertificate
} from '../../src/certify.ts';
import { TaskPool } from '../../src/tasks.ts';

let paths: Record<string, string>;
const certificates = new Map<string, StreamCertificate>();
const bytesOf = (name: string) => new Uint8Array(readFileSync(paths[name]!));

function certify(name: string, entry = name, block = 16): StreamCertificate {
	const key = `${name}:${block}`;
	let found = certificates.get(key);
	if (!found) {
		const result = certifyStream(bytesOf(name), entry, { block });
		assert.equal(
			result.kind,
			'certificate',
			name + ' ' + (result as CertificateRefusal).reason
		);
		found = result as StreamCertificate;
		certificates.set(key, found);
	}
	return found;
}

const refusal = (bytes: Uint8Array, entry: string) => {
	const result = certifyStream(bytes, entry);
	assert.equal(result.kind, 'refusal');
	return result as CertificateRefusal;
};

beforeAll(() => {
	paths = { ...buildSubjects(), ...buildOutputSubjects() };
	const miniz = buildMiniz();
	if (miniz) paths['miniz-crc32'] = miniz;
	const minizAdler = buildMiniz(undefined, 'mz_adler32');
	if (minizAdler) paths['miniz-adler32'] = minizAdler;
}, 60000);

const random = (size: number, salt = 1) =>
	Uint8Array.from(
		{ length: size },
		(_, k) => (Math.imul(k + salt, 2654435761) ^ (k >>> 8)) & 255
	);

// the serial call on a private instance, from any start state
function serial(name: string, certificate: StreamCertificate) {
	const instance = new WebAssembly.Instance(new WebAssembly.Module(bytesOf(name)), {});
	const memory = instance.exports.memory as WebAssembly.Memory;
	const fn = instance.exports[certificate.entry] as (
		...args: (number | bigint)[]
	) => number | bigint;
	const { layout } = certificate;
	return (input: Uint8Array, state: bigint) => {
		const need = (1 << 20) + input.length + 64;
		if (memory.buffer.byteLength < need)
			memory.grow(Math.ceil((need - memory.buffer.byteLength) / 65536));
		new Uint8Array(memory.buffer, 1 << 20, input.length).set(input);
		const args: (number | bigint)[] = [0, 0, 0];
		args[layout.state] =
			layout.bits === 32 ? Number(BigInt.asIntN(32, state)) : BigInt.asIntN(64, state);
		args[layout.ptr] = 1 << 20;
		args[layout.len] = input.length;
		return BigInt.asUintN(layout.bits, BigInt(fn(...args)));
	};
}

describe('certifyStream on compiled kernels', () => {
	test('the loop forms clang emits are certified, with the ring and width the kernel has', () => {
		const expected: [string, string, 32 | 64][] = [
			['crc32c', 'gf2', 32],
			['crc16', 'gf2', 32],
			['poly31', 'z2w', 32],
			['lcg', 'z2w', 32],
			['adler32', 'zp', 32]
		];
		for (const [name, ring, bits] of expected) {
			const c = certify(name);
			assert.equal(c.ring, ring, name);
			assert.equal(c.bits, bits, name);
			assert.equal(c.model.align, 1);
			assert.ok(c.stats.loops > 0, `${name} summarized no loop`);
		}
	});

	test('the proven operator is the sampled one', () => {
		for (const name of ['crc32c', 'poly31', 'lcg']) {
			const c = certify(name);
			const sampled = probeAffine(bytesOf(name), name);
			assert.equal(sampled.kind, 'model');
			if (sampled.kind !== 'model') continue;
			assert.deepEqual(c.model.operator, sampled.operator, name);
		}
	});

	test('a 64-bit state with a table the first call builds is certified with its initialization', () => {
		const c = certify('crc64', 'crc64', 4);
		assert.equal(c.bits, 64);
		assert.ok(c.initialization.length > 0);
		assert.ok(c.exclusions.length > 0);
		const sampled = probeAffine(bytesOf('crc64'), 'crc64');
		assert.equal(sampled.kind, 'model');
		if (sampled.kind === 'model') assert.deepEqual(c.model.operator, sampled.operator);
	});

	test('a function that masks its state reports that a zero length call transforms it', () => {
		assert.equal(certify('crc16').zeroLength, 'transforms');
		assert.equal(certify('crc32c').zeroLength, 'identity');
	});

	test('the miniz CRC-32 with its immutable table is certified and matches zlib', () => {
		if (!paths['miniz-crc32']) return;
		const entry = 'mz_crc32';
		const c = certify('miniz-crc32', entry);
		assert.equal(c.ring, 'gf2');
		assert.ok(c.image.length > 0);
		const input = random(5000);
		assert.equal(serial('miniz-crc32', c)(input, 0n), BigInt(crc32(input) >>> 0));
	});

	test('kernels that are not affine or that keep state elsewhere are refused with a reason', () => {
		assert.match(refusal(bytesOf('fnv1a'), 'fnv1a').reason, /product/);
		assert.match(refusal(bytesOf('sha256c'), 'sha256c').reason, /unsupported expression/);
		assert.equal(refusal(bytesOf('fnv1a'), 'fnv1a').attempts.length, 3);
	});

	test('Adler-32 is certified over two residues mod 65521, and the blocked miniz one is refused', () => {
		const c = certify('adler32');
		assert.equal(c.ring, 'zp');
		assert.equal(c.model.modulus, 65521n);
		assert.equal(c.model.digits, 2);
		assert.deepEqual(c.model.operator, [1n, 0n, 1n, 1n]);
		assert.equal(c.zeroLength, 'identity');
		// a state whose digits are above the modulus is reduced by the first byte
		const run = serial('adler32', c);
		const byte = Uint8Array.of(7);
		for (const start of [0xffffffffn, 0xfff1fff1n, 0x10001n]) {
			const split = predictEnd(c.model, start, 1, run(byte, 0n));
			assert.equal(split, run(byte, start), `start ${start}`);
		}
		if (!paths['miniz-adler32']) return;
		const blocked = refusal(bytesOf('miniz-adler32'), 'mz_adler32');
		assert.match(blocked.reason, /zp: a branch is undecided/);
	});

	test('the model reproduces the serial call over many splits, lengths and start states', () => {
		for (const name of ['crc32c', 'crc16', 'poly31', 'lcg', 'adler32']) {
			const c = certify(name);
			const run = serial(name, c);
			for (const length of [1, 2, 15, 16, 17, 63, 64, 65, 1000, 65537]) {
				const x = random(length, length);
				for (const start of [0n, 1n, 0x80000000n, 0xffffffffn]) {
					const whole = run(x, start);
					for (const width of [2, 3, 5]) {
						let state = start;
						for (let k = 0; k < width; k++) {
							const from = Math.floor((k * length) / width);
							const to = Math.floor(((k + 1) * length) / width);
							if (to === from) continue;
							state = predictEnd(
								c.model,
								state,
								to - from,
								run(x.subarray(from, to), 0n)
							);
						}
						assert.equal(
							state,
							whole,
							`${name} length ${length} start ${start} width ${width}`
						);
					}
				}
			}
		}
	});
});

describe('certifyStream on kernels that rewrite their input', () => {
	const lengths = [1, 2, 3, 5, 9, 17, 100, 1025, 4097];

	// s = s * 1664525 + 13 per byte, then p[i] ^= s >> 24, `u` bytes per iteration and a tail loop
	function xorStream(u: number, hazard = '') {
		const get = (n: string) => `(local.get $${n})`;
		const set = (n: string, v: string) => `(local.set $${n} ${v})`;
		const c = (v: number) => `(i32.const ${v})`;
		const addr = (k: number) => `offset=${k} (i32.add ${get('p')} ${get('i')})`;
		const step = (k: number, tail: boolean) => {
			const shift = hazard === 'wrong-transform' && !tail ? 23 : 24;
			const key = `(i32.shr_u ${get('s')} ${c(shift)})`;
			const byte = `(i32.load8_u ${addr(k)})`;
			const update = set('s', `(i32.add (i32.mul ${get('s')} ${c(1664525)}) ${c(13)})`);
			const out = `(i32.xor ${byte} ${key})`;
			const kind = hazard === 'store16' ? 'store16' : 'store8';
			const where = hazard === 'store-ahead' ? addr(k + 1) : addr(k);
			const store = `(i32.${kind} ${where} ${out})`;
			if (hazard === 'skip-odd' && k % 2 === 1) return `${update} (drop ${byte})`;
			if (hazard === 'counter-store')
				return `${update} (i32.store8 ${addr(k)} (i32.xor ${byte} ${get('i')}))`;
			if (hazard === 'conditional')
				return `${update} (if (i32.and ${byte} ${c(1)}) (then ${store}))`;
			if (hazard === 'reload')
				return `${update} ${store} ${set('s', `(i32.add ${get('s')} (i32.load8_u ${addr(k)}))`)}`;
			if (hazard === 'double') return `${update} ${store} ${store}`;
			return `${update} ${store}`;
		};
		const body = (n: number, tail: boolean) =>
			Array.from({ length: n }, (_, k) => step(k, tail)).join(' ') +
			set('i', `(i32.add ${get('i')} ${c(n)})`);
		const loop = (name: string, end: string, n: number, tail: boolean) =>
			`(if (i32.ne ${get('i')} ${get(end)}) (then (loop $${name} ${body(n, tail)} (br_if $${name} (i32.ne ${get('i')} ${get(end)})))))`;
		return `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
			(local $i i32) (local $m i32)
			${set('m', `(i32.and ${get('n')} ${c(-u)})`)}
			${u > 1 ? loop('main', 'm', u, false) : ''}
			${loop('tail', 'n', 1, true)}
			${get('s')})`;
	}

	test('four in-place kernels are certified with the transform recorded and agree with execution', () => {
		for (const [name, ring] of [
			['xlcg', 'z2w'],
			['xshift', 'gf2'],
			['xsbox', 'gf2'],
			['xfeed', 'z2w']
		] as const) {
			const c = certify(name);
			assert.equal(c.ring, ring, name);
			assert.ok(c.output?.inPlace, name);
			assert.equal(groundTruth(bytesOf(name), c, lengths, 1 << 20), '', name);
		}
		// the generator ignores the bytes, so the step from state zero is recorded; a state that reads them has none
		assert.equal(certify('xlcg').output?.step, 1013904223n);
		assert.equal(certify('xshift').output?.step, 0n);
		assert.equal(certify('xfeed').output?.step, undefined);
	});

	test('a plain loop of the same shape is certified too, and a stream with no stores has no output', () => {
		const c = certifyStream(build(xorStream(1)), 'update');
		assert.equal(c.kind, 'certificate');
		assert.ok(c.kind === 'certificate' && c.output);
		assert.equal(certify('crc32c').output, undefined);
	});

	test('stores that leave the input, repeat, skip, read back or differ between loops are refused', () => {
		for (const hazard of [
			'store-ahead',
			'double',
			'skip-odd',
			'counter-store',
			'conditional',
			'store16',
			'reload',
			'wrong-transform'
		]) {
			const result = certifyStream(build(xorStream(2, hazard)), 'update');
			assert.equal(result.kind, 'refusal', hazard);
		}
	});

	test('the fold route refuses a certificate that rewrites its input', () => {
		const c = certify('xlcg');
		assert.throws(
			() =>
				foldCertified(
					new TaskPool(1),
					new Uint8Array(16),
					new WebAssembly.Memory({ initial: 1 }),
					c
				),
			/rewrites its input/
		);
	});
});

describe('certifyStream on state that holds two residues', () => {
	interface Shape {
		p: number;
		u: number;
		al?: number;
		be?: number;
		ep?: number;
		hazard?: string;
	}

	// a = (al * a + byte) mod p, b = (be * b + ep * a) mod p, `u` bytes per iteration, then a tail loop
	function residues({ p, u, al = 1, be = 1, ep = 1, hazard = '' }: Shape) {
		const get = (n: string) => `(local.get $${n})`;
		const set = (n: string, v: string) => `(local.set $${n} ${v})`;
		const c = (v: number) => `(i32.const ${v})`;
		const rem = (v: string, m: number) =>
			`(i32.${hazard === 'rem-s' ? 'rem_s' : 'rem_u'} ${v} ${c(m)})`;
		const step = (k: number, tail: boolean) => {
			const byte = `(i32.load8_u offset=${k + (hazard === 'load-ahead' ? 1 : 0)} (i32.add ${get('p')} ${get('i')}))`;
			const sum = `(i32.add (i32.mul ${c(al)} ${get('a')}) ${byte})`;
			const a =
				hazard === 'cond-sub'
					? `${set('a', sum)} (if (i32.ge_u ${get('a')} ${c(p)}) (then ${set('a', `(i32.sub ${get('a')} ${c(p)})`)}))`
					: set('a', hazard === 'skip-rem-tail' && tail ? sum : rem(sum, p));
			const mixed = `(i32.add (i32.mul ${c(be)} ${get('b')}) (i32.mul ${c(ep)} ${get('a')}))`;
			const b =
				hazard === 'no-rem-b' ? mixed : rem(mixed, hazard === 'other-modulus' ? p + 2 : p);
			return `${a} ${set('b', b)}`;
		};
		const body = (n: number, tail: boolean) =>
			Array.from({ length: n }, (_, k) => step(k, tail)).join(' ') +
			set('i', `(i32.add ${get('i')} ${c(n)})`);
		const loop = (name: string, end: string, n: number, tail: boolean) =>
			`(if (i32.ne ${get('i')} ${get(end)}) (then (loop $${name} ${body(n, tail)} (br_if $${name} (i32.ne ${get('i')} ${get(end)})))))`;
		const high = hazard === 'swap-pack' ? 'a' : 'b';
		const low = hazard === 'swap-pack' ? 'b' : 'a';
		return `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
			(local $a i32) (local $b i32) (local $i i32) (local $m i32)
			${set('a', `(i32.and ${get('s')} ${c(65535)})`)}
			${set('b', `(i32.shr_u ${get('s')} ${c(16)})`)}
			${set('m', `(i32.and ${get('n')} ${c(-u)})`)}
			${u > 1 ? loop('main', 'm', u, false) : ''}
			${loop('tail', 'n', 1, true)}
			(i32.or (i32.shl ${get(high)} ${c(16)}) ${get(low)}))`;
	}

	const lengths = [1, 2, 3, 5, 9, 17, 100, 1025];

	test('residue folds with different moduli, coefficients and unrolls are certified and agree with execution', () => {
		for (const shape of [
			{ p: 65521, u: 1 },
			{ p: 65521, u: 2 },
			{ p: 65535, u: 4, al: 2, ep: 3 },
			{ p: 65536, u: 2, be: 2 },
			{ p: 251, u: 4, al: 3 }
		]) {
			const bytes = build(residues(shape));
			const c = certifyStream(bytes, 'update');
			assert.equal(c.kind, 'certificate', JSON.stringify(shape));
			if (c.kind !== 'certificate') continue;
			assert.equal(c.ring, 'zp');
			assert.equal(c.model.modulus, BigInt(shape.p));
			assert.equal(groundTruth(bytes, c, lengths, 1 << 20), '', JSON.stringify(shape));
		}
	});

	test('a missing reduction, a second modulus, a signed remainder or a branch on the sum is refused', () => {
		for (const hazard of [
			'no-rem-b',
			'other-modulus',
			'rem-s',
			'cond-sub',
			'skip-rem-tail',
			'swap-pack',
			'load-ahead'
		]) {
			const result = certifyStream(build(residues({ p: 65521, u: 2, hazard })), 'update');
			assert.equal(result.kind, 'refusal', hazard);
		}
		for (const p of [100003, 70001]) {
			const result = certifyStream(build(residues({ p, u: 1 })), 'update');
			assert.equal(result.kind, 'refusal', `modulus ${p}`);
		}
	});
});

describe('certifyStream against modules that differ from a fold somewhere', () => {
	const certified = new Set([
		'control',
		'equivalent-wrapper',
		'poly31',
		'table-crc32',
		'adler32'
	]);

	test('every split-sensitive module is refused, whatever length triggers it', () => {
		for (const m of mutants()) {
			const result = certifyStream(build(m.text), 'update');
			assert.equal(
				result.kind === 'certificate',
				certified.has(m.id),
				`${m.id}: ${result.kind}`
			);
		}
	});

	test('the refusals name a branch the lengths do not decide, a different fold, or an operation', () => {
		for (const m of mutants().filter((x) => /^length-/.test(x.id))) {
			const result = certifyStream(build(m.text), 'update') as CertificateRefusal;
			assert.match(result.reason, /undecided|not the fold/, m.id);
		}
	});
});

describe('certifyStream robustness', () => {
	const wat = (body: string) => build(body);
	const crcStep = `(func $update (export "update") (param i32 i32 i32) (result i32) (local i32)
		(block $g (br_if $g (i32.eqz (local.get 2)))
			(loop $l (nop) (local.set 3 (i32.load8_u (local.get 1)))
				(local.set 0 (i32.xor (local.get 0) (local.get 3)))
				(local.set 1 (i32.add (local.get 1) (i32.const 1)))
				(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
		(local.get 0))`;

	test('a nop is skipped and a br_table is refused, neither throws', () => {
		assert.equal(certifyStream(wat(crcStep), 'update').kind, 'certificate');
		const table = wat(`(func $update (export "update") (param i32 i32 i32) (result i32)
			(block $a (block $b (br_table $a $b (local.get 2))) (return (local.get 0))) (local.get 0))`);
		assert.equal(certifyStream(table, 'update').kind, 'refusal');
	});

	test('overlapping data segments read the byte the last segment wrote', () => {
		const bytes = binaryen.parseText(`(module (memory (export "memory") 32 512)
			(data (i32.const 1048576) "\\01") (data (i32.const 1048576) "\\03")
			(func $update (export "update") (param i32 i32 i32) (result i32)
				(block $g (br_if $g (i32.eqz (local.get 2)))
					(loop $l
						(local.set 0 (i32.add (i32.mul (local.get 0) (i32.load8_u (i32.const 1048576)))
							(i32.load8_u (local.get 1))))
						(local.set 1 (i32.add (local.get 1) (i32.const 1)))
						(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
				(local.get 0)))`);
		const module = Uint8Array.from(bytes.emitBinary());
		bytes.dispose();
		const c = certifyStream(module, 'update');
		assert.equal(c.kind, 'certificate');
		if (c.kind === 'certificate') assert.equal(c.model.operator, 3n);
	});

	test('a head-test loop that may run zero times does not leave a folded copy behind', () => {
		const xor16 = Array.from(
			{ length: 16 },
			(_, k) => `(i32.load8_u offset=${k} (local.get $p))`
		).reduce((acc, l) => `(i32.xor ${acc} ${l})`, '(local.get $s)');
		const module = binaryen.parseText(`(module (memory (export "memory") 32 512)
			(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
				(local $i i32) (local $tmp i32) (local $k i32) (local $acc i32)
				(if (i32.lt_u (local.get $n) (i32.const 16))
					(then
						(local.set $acc (local.get $s))
						(local.set $k (local.get $n))
						(if (local.get $k) (then
							(loop $a
								(local.set $acc (i32.xor (local.get $acc) (i32.load8_u (local.get $p))))
								(local.set $p (i32.add (local.get $p) (i32.const 1)))
								(local.set $k (i32.sub (local.get $k) (i32.const 1)))
								(br_if $a (local.get $k)))))
						(return (local.get $acc))))
				(block $x
					(loop $l
						(br_if $x (i32.eq (local.get $i) (i32.sub (i32.shr_u (local.get $n) (i32.const 4)) (i32.const 1))))
						(local.set $tmp ${xor16})
						(local.set $s (local.get $tmp))
						(local.set $p (i32.add (local.get $p) (i32.const 16)))
						(local.set $i (i32.add (local.get $i) (i32.const 1)))
						(br $l)))
				(local.set $acc (local.get $tmp))
				(local.set $k (i32.sub (local.get $n) (i32.shl (local.get $i) (i32.const 4))))
				(loop $m
					(local.set $acc (i32.xor (local.get $acc) (i32.load8_u (local.get $p))))
					(local.set $p (i32.add (local.get $p) (i32.const 1)))
					(local.set $k (i32.sub (local.get $k) (i32.const 1)))
					(br_if $m (local.get $k)))
				(local.get $acc)))`);
		const bytes = Uint8Array.from(module.emitBinary());
		module.dispose();
		assert.equal(certifyStream(bytes, 'update').kind, 'refusal');
	});

	test('a module with two memories is refused', () => {
		const module =
			binaryen.parseText(`(module (memory $m0 (export "memory") 32 512) (memory $m1 32 512)
			(func $update (export "update") (param i32 i32 i32) (result i32) (local.get 0)))`);
		module.setFeatures(binaryen.Features.All);
		const bytes = Uint8Array.from(module.emitBinary());
		module.dispose();
		const result = certifyStream(bytes, 'update') as CertificateRefusal;
		assert.equal(result.kind, 'refusal');
		assert.match(result.reason, /more than one memory/);
	});

	test('bad inputs are refusals', () => {
		assert.equal(certifyStream(Uint8Array.of(1, 2, 3), 'update').kind, 'refusal');
		assert.equal(certifyStream(bytesOf('crc32c'), 'missing').kind, 'refusal');
		assert.equal(certifyStream(bytesOf('crc32c'), 'memory').kind, 'refusal');
		assert.equal(certifyStream(bytesOf('crc32c'), 'crc32c', { block: 3 }).kind, 'refusal');
		assert.equal(
			certifyStream(bytesOf('crc32c'), 'crc32c', { layout: { state: 0, ptr: 0, len: 2 } })
				.kind,
			'refusal'
		);
	});

	test('a state that is shared, a start function and imports are refused', () => {
		assert.equal(
			certifyStream(wat(`(func $s) (start $s) ${crcStep}`), 'update').kind,
			'refusal'
		);
		const imported = binaryen.parseText(
			`(module (import "env" "f" (func $f)) (memory (export "memory") 32 512) ${crcStep})`
		);
		const bytes = Uint8Array.from(imported.emitBinary());
		imported.dispose();
		const result = certifyStream(bytes, 'update') as CertificateRefusal;
		assert.equal(result.kind, 'refusal');
		assert.match(result.reason, /imports/);
	});

	test('a step that ignores the state is an affine map with a zero operator', () => {
		const c = certifyStream(
			wat(`(func $update (export "update") (param i32 i32 i32) (result i32) (local i32)
				(block $g (br_if $g (i32.eqz (local.get 2)))
					(loop $l (local.set 0 (i32.xor (i32.load8_u (local.get 1)) (i32.const 5)))
						(local.set 1 (i32.add (local.get 1) (i32.const 1)))
						(br_if $l (local.tee 2 (i32.add (local.get 2) (i32.const -1))))))
				(local.get 0))`),
			'update'
		);
		assert.equal(c.kind, 'certificate');
		if (c.kind === 'certificate')
			assert.ok((c.model.operator as bigint[]).every((col) => col === 0n));
	});
});

describe('certifyStream after review of the residue ring and the output proof', () => {
	const get = (n: string) => `(local.get $${n})`;
	const set = (n: string, v: string) => `(local.set $${n} ${v})`;
	const c = (v: number) => `(i32.const ${v})`;

	// s = 2 * s + byte, with a tail of 63 more bytes than the remainder; for a remainder of 38 or more the tail
	// reaches input position 100 and adds 2^31 * (state + byte 100), which the one byte image used to hide
	function imageCollision() {
		return `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
			(local $i i32) (local $j i32) (local $x i32) (local $t i32) (local $e i32) (local $m i32)
			(if (i32.ge_u ${get('n')} ${c(64)}) (then
				${set('m', `(i32.sub (i32.and ${get('n')} ${c(-64)}) ${c(63)})`)}
				(loop $a
					${set('x', `(i32.load8_u (i32.add ${get('p')} ${get('i')}))`)}
					${set('s', `(i32.add (i32.mul ${get('s')} ${c(2)}) ${get('x')})`)}
					${set('i', `(i32.add ${get('i')} ${c(1)})`)}
					(br_if $a (i32.ne ${get('i')} ${get('m')})))))
			${set('t', get('s'))}
			${set('j', get('i'))}
			(if (i32.ne ${get('j')} ${get('n')}) (then
				(loop $b
					${set('x', `(i32.load8_u (i32.add ${get('p')} ${get('j')}))`)}
					(if (i32.eq (i32.sub ${get('j')} ${get('i')}) ${c(100)}) (then ${set('e', get('x'))}))
					${set('s', `(i32.add (i32.mul ${get('s')} ${c(2)}) ${get('x')})`)}
					${set('j', `(i32.add ${get('j')} ${c(1)})`)}
					(br_if $b (i32.ne ${get('j')} ${get('n')})))))
			(if (i32.gt_u (i32.sub ${get('n')} ${get('i')}) ${c(100)}) (then
				${set('s', `(i32.add ${get('s')} (i32.shl (i32.add ${get('t')} ${get('e')}) ${c(31)}))`)}))
			${get('s')})`;
	}

	test('a tail that reaches the position the one byte image used is refused', () => {
		const result = certifyStream(build(imageCollision()), 'update', { block: 64 });
		assert.equal(result.kind, 'refusal');
	});

	// a load whose address and offset immediate together stay in range for the checker's 32-bit sum but not for wasm's
	function immediate(offset: string, address: string) {
		return `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
			(local $i i32)
			(block $done (loop $l
				(br_if $done (i32.ge_u ${get('i')} ${get('n')}))
				${set('s', `(i32.add (i32.mul ${get('s')} ${c(31)}) (i32.load8_u offset=${offset} ${address}))`)}
				${set('i', `(i32.add ${get('i')} ${c(1)})`)}
				(br $l)))
			${get('s')})`;
	}

	test('an offset immediate that wraps the address, or that reaches below the pointer, is refused', () => {
		const wraps = `(i32.add (i32.add ${get('p')} ${get('i')}) ${c(1)})`;
		const below = `(i32.sub (i32.add ${get('p')} ${get('i')}) ${c(1)})`;
		assert.equal(
			certifyStream(build(immediate('4294967295', wraps)), 'update').kind,
			'refusal'
		);
		assert.equal(certifyStream(build(immediate('1', below)), 'update').kind, 'refusal');
	});

	test('the input guard rejects a length of 2^32, a negative pointer and fractions', () => {
		const c1 = certify('crc32c');
		assert.equal(guardInput(c1, 1 << 21, 1 << 20, 2 ** 32), false);
		assert.equal(guardInput(c1, 1 << 21, -1, 1), false);
		assert.equal(guardInput(c1, 1 << 21, 1 << 20, 1.5), false);
		assert.equal(guardInput(c1, 1 << 21, 1 << 20, 100), true);
	});

	test('an unknown ring is a refusal and a forged certificate does not verify', () => {
		const result = certifyStream(bytesOf('crc32c'), 'crc32c', { ring: 'nope' as 'gf2' });
		assert.equal(result.kind, 'refusal');
		const forged = { ...certify('crc32c'), ring: 'nope' as 'gf2' };
		assert.equal(verifyCertificate(bytesOf('crc32c'), forged), false);
	});

	test('a chain of squares of a byte stops at the time limit instead of running on', () => {
		let body = set('x', `(i32.load8_u ${get('p')})`);
		for (let k = 0; k < 12; k++) body += set('x', `(i32.mul ${get('x')} ${get('x')})`);
		const text = `(func $update (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
			(local $x i32) (local $i i32)
			(if (i32.ne ${get('i')} ${get('n')}) (then
				(loop $l ${body}
					${set('s', `(i32.xor ${get('s')} ${get('x')})`)}
					${set('p', `(i32.add ${get('p')} ${c(1)})`)}
					${set('i', `(i32.add ${get('i')} ${c(1)})`)}
					(br_if $l (i32.ne ${get('i')} ${get('n')})))))
			${get('s')})`;
		const started = Date.now();
		const result = certifyStream(build(text), 'update', { maxMs: 2000 });
		assert.ok(Date.now() - started < 15000, 'the limit is enforced across the ladder');
		assert.equal(result.kind === 'certificate' || /time limit/.test(result.reason), true);
	});
});

describe('certificates', () => {
	test('a certificate re-derives from the module, and a changed one does not', () => {
		const c = certify('crc32c');
		assert.equal(verifyCertificate(bytesOf('crc32c'), c), true);
		assert.equal(verifyCertificate(bytesOf('poly31'), c), false);
		const tampered = {
			...c,
			model: { ...c.model, operator: [...(c.model.operator as bigint[])].reverse() }
		};
		assert.equal(verifyCertificate(bytesOf('crc32c'), tampered), false);
		assert.equal(verifyCertificate(bytesOf('crc32c'), { ...c, checker: 'other' }), false);
	});

	test('the input guard keeps the range inside memory and clear of tables the proof read', () => {
		const c = certify('crc16');
		const [start, end] = c.exclusions[0]!;
		assert.equal(guardInput(c, 1 << 21, 1 << 20, 100), true);
		assert.equal(guardInput(c, 1 << 21, start, 1), false);
		assert.equal(guardInput(c, 1 << 21, start - 5, 10), false);
		assert.equal(guardInput(c, 1 << 21, end, 10), true);
		assert.equal(guardInput(c, 100, 90, 20), false);
		assert.equal(guardInput(c, 2 ** 33, 0, 1), false);
		assert.equal(guardInput(c, -1, 0, 1), false);
	});
});

describe('certified execution on shared memory', () => {
	const open: { pool: TaskPool; workers: Worker[] }[] = [];
	const worker = new URL('../../scripts/research/certified-worker.ts', import.meta.url);

	afterAll(async () => {
		for (const { pool, workers } of open.splice(0)) {
			pool.close();
			await Promise.all(workers.map((w) => w.terminate()));
		}
	});

	function shared(name: string, entry: string, width = 3, pages = 40) {
		const c = certify(name, entry, name === 'crc64' ? 4 : 16);
		const subject = shareCertified(bytesOf(name), c, pages);
		const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
		installPrefill(subject, memory);
		const module = new WebAssembly.Module(subject.bytes);
		const pool = new TaskPool(width);
		const workers = Array.from({ length: width }, (_, i) => {
			const link = pool.link(i);
			return new Worker(worker, {
				workerData: { link, module, memory, layout: c.layout },
				transferList: [link.port]
			});
		});
		open.push({ pool, workers });
		return { c, memory, pool };
	}

	test('workers read the input in place and the combined state equals the serial call', () => {
		for (const [name, entry] of [
			['crc32c', 'crc32c'],
			['poly31', 'poly31'],
			['crc16', 'crc16'],
			['adler32', 'adler32'],
			['crc64', 'crc64']
		] as const) {
			const { c, memory, pool } = shared(name, entry);
			const run = serial(name, c);
			const input = new Uint8Array(memory.buffer, 1 << 20, 300000);
			input.set(random(300000, 9));
			for (const initial of [0n, 7n, 0xffffffffn]) {
				const folded = foldCertified(pool, input, memory, c, { initial });
				assert.equal(
					folded.state,
					run(Uint8Array.from(input), initial),
					`${name} ${initial}`
				);
				assert.equal(folded.tasks, 3);
			}
			const odd = foldCertified(pool, input.subarray(0, 100001), memory, c);
			assert.equal(odd.state, run(Uint8Array.from(input.subarray(0, 100001)), 0n), name);
		}
	});

	test('workers rewrite the input in place from their own start state and the bytes equal the serial call', () => {
		for (const name of ['xlcg', 'xshift', 'xsbox']) {
			const { c, memory, pool } = shared(name, name);
			const data = random(300001, 5);
			const instance = new WebAssembly.Instance(new WebAssembly.Module(bytesOf(name)), {});
			const reference = instance.exports.memory as WebAssembly.Memory;
			reference.grow(Math.ceil((1 << 20) / 65536) + 8);
			const fn = instance.exports[name] as (s: number, p: number, n: number) => number;
			for (const initial of [0n, 7n, 0xffffffffn]) {
				new Uint8Array(reference.buffer, 1 << 20, data.length).set(data);
				const end = fn(Number(BigInt.asIntN(32, initial)), 1 << 20, data.length) >>> 0;
				const expected = Uint8Array.from(
					new Uint8Array(reference.buffer, 1 << 20, data.length)
				);
				const input = new Uint8Array(memory.buffer, 1 << 20, data.length);
				input.set(data);
				const done = reconstructCertified(pool, input, memory, c, { initial });
				assert.equal(done.tasks, 3);
				assert.equal(done.state, BigInt(end), `${name} ${initial}`);
				assert.ok(Buffer.from(input).equals(expected), `${name} ${initial} bytes`);
			}
		}
	});

	test('a kernel whose state reads the bytes cannot start its chunks apart', () => {
		const { c, memory, pool } = shared('xfeed', 'xfeed');
		const input = new Uint8Array(memory.buffer, 1 << 20, 4096);
		assert.throws(() => reconstructCertified(pool, input, memory, c), /does not let chunks/);
	});

	test('empty, one byte and one chunk calls are the serial call', () => {
		const { c, memory, pool } = shared('crc16', 'crc16');
		const run = serial('crc16', c);
		const all = new Uint8Array(memory.buffer, 1 << 20, 64);
		all.set(random(64, 3));
		for (const length of [0, 1, 2, 63])
			for (const initial of [0n, 0xdeadbeefn])
				assert.equal(
					foldCertified(pool, all.subarray(0, length), memory, c, { initial }).state,
					run(Uint8Array.from(all.subarray(0, length)), initial),
					`length ${length} initial ${initial}`
				);
		assert.equal(
			foldCertified(pool, all, memory, c, { chunks: [{ start: 0, end: 64 }] }).chunks,
			1
		);
	});

	test('input outside the memory, over the table, or split badly is refused', () => {
		const { c, memory, pool } = shared('crc16', 'crc16');
		const [start] = c.exclusions[0]!;
		assert.throws(
			() => foldCertified(pool, new Uint8Array(memory.buffer, start, 16), memory, c),
			RangeError
		);
		assert.throws(() => foldCertified(pool, new Uint8Array(100), memory, c), RangeError);
		const input = new Uint8Array(memory.buffer, 1 << 20, 100);
		assert.throws(
			() =>
				foldCertified(pool, input, memory, c, {
					chunks: [
						{ start: 0, end: 50 },
						{ start: 60, end: 100 }
					]
				}),
			RangeError
		);
		assert.throws(
			() =>
				foldCertified(pool, input, memory, c, {
					chunks: [
						{ start: 0, end: 50 },
						{ start: 50, end: 90 }
					]
				}),
			RangeError
		);
	});

	test('the shared module keeps its functions, and a certificate for another module is refused', () => {
		const c = certify('poly31');
		const subject = shareCertified(bytesOf('poly31'), c, 40);
		const original = binaryen.readBinary(bytesOf('poly31'));
		const derived = binaryen.readBinary(subject.bytes);
		const body = (m: binaryen.Module) =>
			m
				.emitText()
				.split('\n')
				.filter((l) => !/\(memory|\(import|producers|features|\(module|\(export/.test(l))
				.join('\n')
				.replace(/\(func \$[^\s)]+/g, '(func $f');
		assert.equal(body(derived), body(original));
		original.dispose();
		derived.dispose();
		assert.throws(() => shareCertified(bytesOf('crc32c'), c, 40), /different module/);
		assert.throws(() => shareCertified(bytesOf('poly31'), c, 1), RangeError);
		const memory = new WebAssembly.Memory({ initial: 41, maximum: 41, shared: true });
		assert.throws(() => installPrefill(subject, memory), RangeError);
		assert.ok(typeof serveCertified === 'function');
	});
});
