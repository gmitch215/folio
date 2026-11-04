import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyStream, type StreamCertificate } from '../../../../src/certify.ts';
import { defaultOut } from '../../affine-build.ts';
import { groundTruth } from '../../certify-ground.ts';
import { buildC, buildWat, ground2, outDir, pickBase } from './lib.ts';
import { cSpecs } from './specs-c.ts';
import { wSpecs } from './specs-w.ts';

// negative control for the ground truth: a certificate checked against a module it does not
// describe must fail, and the genuine pair must pass; needs `bun run build:c` and writes control.json
const file = (n: string) => new Uint8Array(readFileSync(join(defaultOut, `${n}.wasm`)));
const cOf = (id: string) => {
	const s = cSpecs.find((x) => x.id === id)!;
	return buildC(s.src, s.opt!);
};
const wOf = (id: string) => buildWat(wSpecs.find((x) => x.id === id)!.src);

const cert = (bytes: Uint8Array, entry: string): StreamCertificate => {
	const c = certifyStream(bytes, entry);
	if (c.kind !== 'certificate') throw new Error(`refused ${entry}: ${c.reason}`);
	return c;
};
const retarget = (c: StreamCertificate, entry = 'update'): StreamCertificate => ({
	...c,
	entry,
	layout: { ...c.layout, entry },
	model: { ...c.model, layout: { ...c.model.layout, entry } }
});

const adler = cert(file('adler32'), 'adler32');
const xlcg = cert(file('xlcg'), 'xlcg');
const xshift = cert(file('xshift'), 'xshift');
const pairs: [string, StreamCertificate, Uint8Array][] = [];
// the adler certificate against another modulus, a different coefficient, no reduction
for (const id of [
	'rw-adler/mixed-P-head',
	'rw-adler/no-rem2-head',
	'rw-adler/s2-mul-head',
	'rw-adler/ok-P251-head',
	'rw-adler/pack-or15-head'
])
	pairs.push([`adler certificate on ${id}`, retarget(adler), wOf(id)]);
pairs.push(['adler certificate on rc-byte P65519 (C)', retarget(adler), cOf('rc-byte/P65535-O2')]);
// the xlcg certificate (which has a step) against a kernel whose state reads the byte and other keystreams
pairs.push(['xlcg certificate on xfeed', retarget(xlcg, 'xfeed'), file('xfeed')]);
pairs.push(['xlcg certificate on lcg-xor8', retarget(xlcg), cOf('oc-loop/lcg-xor8-O2')]);
pairs.push([
	'xlcg certificate on idx-key (position keystream)',
	retarget(xlcg),
	cOf('oc-loop/idx-key-O2')
]);
pairs.push([
	'xlcg certificate on xor-const-only',
	retarget(xlcg),
	cOf('oc-loop/xor-const-only-O2')
]);
pairs.push(['xshift certificate on xs-add', retarget(xshift), cOf('oc-loop/xs-add-O2')]);
pairs.push(['xshift certificate on xlcg bytes', retarget(xshift, 'xlcg'), file('xlcg')]);

// these two share the state recurrence of the certificate and differ only in the output byte, which
// the certificate does not describe, so the ground truth passes them
const sameState = new Set(['xlcg certificate on lcg-xor8', 'xshift certificate on xs-add']);
const results: { name: string; ground: string; ground2: string; caught: boolean }[] = [];
let bad = 0;
const check = (name: string, c: StreamCertificate, bytes: Uint8Array, mustPass: boolean) => {
	const g = groundTruth(bytes, c, [1, 2, 17, 257, 4097], pickBase(c));
	const g2 = ground2(bytes, c, false);
	const caught = !!(g || g2);
	results.push({ name, ground: g, ground2: g2, caught });
	console.log(name.padEnd(55), g || '-', '|', g2 || '-', mustPass ? '(must pass)' : '');
	if (mustPass ? caught : !caught && !sameState.has(name)) bad++;
};
for (const [name, c, bytes] of pairs) check(name, c, bytes, false);
check('adler on itself', adler, file('adler32'), true);
check('xlcg on itself', xlcg, file('xlcg'), true);
check('xshift on itself', xshift, file('xshift'), true);
writeFileSync(join(outDir, 'control.json'), JSON.stringify(results, null, 1));
console.log(
	bad
		? `${bad} controls behaved wrongly`
		: 'every mismatched pair was caught except the two with the same state, and every genuine pair passed'
);
process.exit(bad ? 1 : 0);
