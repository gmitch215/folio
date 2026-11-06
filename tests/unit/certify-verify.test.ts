import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, test } from 'vitest';
import { buildSubjects } from '../../scripts/research/affine-build.ts';
import { mutants } from '../../scripts/research/certify-verify-mutants.ts';
import { verifyCertificate } from '../../scripts/research/certify-verify.ts';
import { certifyStream, type StreamCertificate } from '../../src/certify.ts';

// the full agreement, mutant and red-team runs live in scripts/research/certify-verify-run.ts
const FAST = { full: 24, big: [], some: [1, 2, 17], huge: [] };
const FAST_MUTANTS: Record<string, string[]> = {
	crc32c: ['operator-0-0', 'module-digest', 'entry-only', 'excl-extra'],
	lcg: ['operator-plus1', 'zero-transforms']
};

let paths: Record<string, string>;
const certified = new Map<string, { bytes: Uint8Array; cert: StreamCertificate }>();
const certify = (name: string) => {
	const known = certified.get(name);
	if (known) return known;
	const bytes = new Uint8Array(readFileSync(paths[name]!));
	const cert = certifyStream(bytes, name);
	assert.equal(cert.kind, 'certificate', name);
	const out = { bytes, cert: cert as StreamCertificate };
	certified.set(name, out);
	return out;
};

beforeAll(() => {
	paths = buildSubjects();
}, 60000);

const kernel = (body: string, memory = '(memory (export "memory") 2)') => {
	const m = binaryen.parseText(`(module ${memory}
		(func (export "update") (param $s i32) (param $p i32) (param $n i32) (result i32)
			(block $g (br_if $g (i32.eqz (local.get $n)))
				(loop $l
					${body}
					(local.set $p (i32.add (local.get $p) (i32.const 1)))
					(br_if $l (local.tee $n (i32.sub (local.get $n) (i32.const 1))))))
			(local.get $s)))`);
	try {
		m.setFeatures(binaryen.Features.All & ~(binaryen.Features as any).CompactImports);
		assert.ok(m.validate());
		return Uint8Array.from(m.emitBinary());
	} finally {
		m.dispose();
	}
};
const step = (mul: number, offset = 0) =>
	`(local.set $s (i32.add (i32.mul (local.get $s) (i32.const ${mul})) (i32.load8_u offset=${offset} (local.get $p))))`;
const poly = (mul: number, offset = 0) => kernel(step(mul, offset));
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const polyBase = poly(31);
const polyCert = certifyStream(polyBase, 'update') as StreamCertificate;
const rebind = (other: Uint8Array): StreamCertificate => ({
	...structuredClone(polyCert),
	moduleSha256: digest(other)
});

describe('independent verifier agrees with the checker', () => {
	for (const name of ['crc32c', 'lcg'])
		test(`accepts the certificate of ${name}`, () => {
			const { bytes, cert } = certify(name);
			const v = verifyCertificate(bytes, cert, FAST);
			assert.equal(v.ok, true, v.reason);
			assert.ok(v.cases > 20);
		});
});

describe('independent verifier on certificate mutants', () => {
	for (const [name, ids] of Object.entries(FAST_MUTANTS))
		test(`rejects the changing mutants and accepts the equivalent ones of ${name}`, () => {
			const { bytes, cert } = certify(name);
			const chosen = mutants(cert).filter((m) => ids.includes(m.id));
			assert.deepEqual(chosen.map((m) => m.id).sort(), [...ids].sort());
			for (const m of chosen) {
				const v = verifyCertificate(bytes, m.cert, FAST);
				if (m.claim === 'changes') assert.equal(v.ok, false, `${m.id} survived`);
				else assert.equal(v.ok, true, `${m.id}: ${v.reason}`);
			}
		}, 60000);
});

describe('independent verifier on modules the certificate does not describe', () => {
	test('accepts the module it was made for', () => {
		assert.equal(polyCert.kind, 'certificate');
		assert.equal(verifyCertificate(polyBase, polyCert, FAST).ok, true);
	});
	test('rejects another multiplier under a matching digest', () => {
		const other = poly(33);
		assert.equal(verifyCertificate(other, rebind(other), FAST).ok, false);
	});
	test('rejects a kernel that reads one byte past its input', () => {
		const other = poly(31, 1);
		const v = verifyCertificate(other, rebind(other), FAST);
		assert.equal(v.ok, false);
	});
	test('rejects a kernel that ignores the last byte', () => {
		const other = kernel(
			`(if (i32.gt_u (local.get $n) (i32.const 1)) (then (local.set $s (i32.add (i32.mul (local.get $s) (i32.const 31)) (i32.load8_u (local.get $p))))))`
		);
		assert.equal(verifyCertificate(other, rebind(other), FAST).ok, false);
	});
	test('rejects a digest that does not match the module', () => {
		assert.equal(verifyCertificate(poly(33), polyCert, FAST).ok, false);
	});
});

describe('independent verifier at lengths too long to derive', () => {
	const LONG = { ...FAST, huge: [65536, 65537, 70001] };
	for (const name of ['lcg', 'adler32'])
		test(`accepts ${name} when the module is run at long lengths`, () => {
			const { bytes, cert } = certify(name);
			const v = verifyCertificate(bytes, cert, { ...FAST, huge: [65537] });
			assert.equal(v.ok, true, v.reason);
		});
	test('accepts a bit-linear fold when the module is run at long lengths', () => {
		const bytes = kernel(
			'(local.set $s (i32.xor (i32.shl (local.get $s) (i32.const 1)) (i32.load8_u (local.get $p))))'
		);
		const cert = certifyStream(bytes, 'update') as StreamCertificate;
		assert.equal(cert.ring, 'gf2');
		const v = verifyCertificate(bytes, cert, { ...FAST, huge: [65537] });
		assert.equal(v.ok, true, v.reason);
	});
	test('accepts a plain fold at 2^16 - 1 to 70001', () => {
		const v = verifyCertificate(polyBase, polyCert, LONG);
		assert.equal(v.ok, true, v.reason);
		assert.equal(v.cases, verifyCertificate(polyBase, polyCert, FAST).cases + 3);
	});
	const rejects = (name: string, body: string, reason: RegExp) =>
		test(name, () => {
			const other = kernel(`${body} ${step(31)}`);
			assert.equal(verifyCertificate(other, rebind(other), FAST).ok, true);
			const v = verifyCertificate(other, rebind(other), LONG);
			assert.equal(v.ok, false);
			assert.match(v.reason, reason);
		});
	rejects(
		'rejects a module that traps above 70000 bytes',
		'(if (i32.gt_u (local.get $n) (i32.const 70000)) (then (unreachable)))',
		/traps at length 70001/
	);
	rejects(
		'rejects a module that traps when the count passes 1000',
		'(if (i32.eq (local.get $n) (i32.const 1000)) (then (unreachable)))',
		/traps at length 65536/
	);
	rejects(
		'rejects a module that changes the state once above 70000 bytes',
		'(if (i32.gt_u (local.get $n) (i32.const 70000)) (then (local.set $s (i32.add (local.get $s) (i32.const 1)))))',
		/split at 1 at length 70001/
	);
});

describe('independent verifier on a one-page memory', () => {
	test('places its probes clear of a fixed read at the last byte', () => {
		const other = kernel(
			`(local.set $s (i32.add (i32.mul (local.get $s) (i32.const 31)) (i32.add (i32.load8_u (local.get $p)) (i32.load8_u (i32.const 65535)))))`,
			'(memory (export "memory") 1)'
		);
		const cert = certifyStream(other, 'update');
		assert.equal(cert.kind, 'certificate');
		const c = cert as StreamCertificate;
		assert.deepEqual(c.exclusions, [[65535, 65536]]);
		const v = verifyCertificate(other, c, FAST);
		assert.equal(v.ok, true, v.reason);
	});
});

describe('independent verifier fails closed on work it cannot bound', () => {
	const table = Array.from(
		{ length: 256 },
		(_, i) => '\\' + ((Math.imul(i + 1, 2654435761) >>> 13) & 255).toString(16).padStart(2, '0')
	).join('');
	test('refuses when the symbolic state outgrows its memory bound', () => {
		const other = kernel(
			`(local.set $s (i32.load8_u offset=1024 (i32.and (i32.xor (local.get $s) (i32.load8_u (local.get $p))) (i32.const 255))))`,
			`(memory (export "memory") 2) (data (i32.const 1024) "${table}")`
		);
		const xor = certifyStream(
			kernel(
				`(local.set $s (i32.xor (i32.shl (local.get $s) (i32.const 1)) (i32.load8_u (local.get $p))))`
			),
			'update'
		) as StreamCertificate;
		assert.equal(xor.ring, 'gf2');
		const cert = { ...xor, moduleSha256: digest(other) };
		const v = verifyCertificate(other, cert, { ...FAST, memory: 100_000 });
		assert.deepEqual([v.ok, v.reason], [false, 'the symbolic state outgrew its memory bound']);
	});
	test('refuses a call that never ends at its own step limit', () => {
		const other = kernel('(br $l)');
		const v = verifyCertificate(other, rebind(other), FAST);
		assert.deepEqual([v.ok, v.reason], [false, 'step limit']);
	});
	test('refuses when the whole run spends its step budget', () => {
		const v = verifyCertificate(polyBase, polyCert, { ...FAST, steps: 1000 });
		assert.deepEqual([v.ok, v.reason], [false, 'the step budget of the whole run is spent']);
	});
});

describe('the checker overstates an identity store', () => {
	test('certifies an in-place output where the verifier sees none', () => {
		const other = kernel(
			`${step(31)} (i32.store8 (local.get $p) (i32.load8_u (local.get $p)))`
		);
		const cert = certifyStream(other, 'update');
		assert.equal(cert.kind, 'certificate');
		assert.deepEqual((cert as StreamCertificate).output, { inPlace: true });
		const v = verifyCertificate(other, cert as StreamCertificate, FAST);
		assert.deepEqual(
			[v.ok, v.reason],
			[false, 'the certificate has an output the call does not produce']
		);
	});
});

describe('independent verifier refuses what it cannot model', () => {
	const refuses = (name: string, reason: string, body: string, memory?: string) =>
		test(name, () => {
			const other = kernel(body, memory);
			const v = verifyCertificate(other, rebind(other), FAST);
			assert.deepEqual([v.ok, v.reason], [false, reason]);
		});
	refuses(
		'memory.grow',
		'memory.size and memory.grow are not supported',
		'(drop (memory.grow (i32.const 0)))'
	);
	refuses(
		'a global write',
		'the function writes a global',
		'(global.set $g (local.get $s))',
		'(memory (export "memory") 2) (global $g (mut i32) (i32.const 0))'
	);
	refuses('a float constant', 'unsupported instruction 0x43', '(drop (f32.const 1))');
	refuses(
		'call_indirect',
		'unsupported instruction 0x11',
		'(drop (call_indirect (type $t) (i32.const 0)))',
		'(memory (export "memory") 2) (type $t (func (result i32))) (table 1 funcref)'
	);
	refuses(
		'a branch on input data',
		'a branch depends on a symbolic value',
		'(if (i32.load8_u (local.get $p)) (then (nop)))'
	);
	refuses(
		'a store to an address read from the input',
		'store to a symbolic address',
		'(i32.store8 (i32.load8_u (local.get $p)) (i32.const 0))'
	);
	refuses(
		'two memories',
		'the module does not have exactly one memory',
		'',
		'(memory (export "memory") 2) (memory 1)'
	);
	refuses(
		'a start function',
		'the module has a start function',
		'',
		'(memory (export "memory") 2) (func $init) (start $init)'
	);
	refuses(
		'an import',
		'the module has imports',
		'',
		'(import "env" "f" (func $f)) (memory (export "memory") 2)'
	);
});
