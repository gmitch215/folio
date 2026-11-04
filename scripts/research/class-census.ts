import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildMiniz, buildSubjects } from './affine-build.ts';

const target = process.argv[2];
if (!target) throw new Error('usage: class-census.ts OUTPUT_JSON');
assert.ok(!existsSync(target), `refusing to overwrite ${target}`);

// static census of what each real compiled subject needs from a certifier
const paths = buildSubjects();
const miniz = buildMiniz();
if (miniz) paths['miniz-crc32'] = miniz;
const rows: object[] = [];
for (const [name, path] of Object.entries(paths)) {
	const mod = binaryen.readBinary(readFileSync(path));
	const text = mod.emitText();
	mod.dispose();
	const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;
	const ops = new Map<string, number>();
	for (const [, , op] of text.matchAll(/\((i32|i64|f32|f64|v128)\.([a-z_0-9]+)/g))
		ops.set(`${op}`, (ops.get(`${op}`) ?? 0) + 1);
	const has = (...names: string[]) => names.some((n) => ops.has(n));
	rows.push({
		name,
		loops: count(/\(loop /g),
		i64: count(/\(i64\./g) > 0,
		xorAndShift: has('xor', 'and', 'shl', 'shr_u', 'shr_s', 'rotl', 'rotr'),
		mulAdd: has('mul'),
		divRem: has('rem_u', 'div_u', 'rem_s', 'div_s'),
		selectOrIf: count(/\(select/g) + count(/\(if /g),
		loadsTotal: count(/\.load/g),
		dataSegments: count(/\(data /g),
		simd: count(/v128/g) > 0,
		ops: [...ops]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([o, c]) => `${o}:${c}`)
	});
}
writeFileSync(target, JSON.stringify(rows, null, 2) + '\n', { flag: 'wx' });
for (const r of rows as any[])
	console.log(
		r.name,
		'loops',
		r.loops,
		'i64',
		r.i64,
		'mul',
		r.mulAdd,
		'divrem',
		r.divRem,
		'sel/if',
		r.selectOrIf,
		'loads',
		r.loadsTotal,
		'data',
		r.dataSegments,
		'simd',
		r.simd
	);
