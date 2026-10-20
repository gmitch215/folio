import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { prepare } from '../../src/compiler.ts';

const build = (name: string) => new URL(`../../build/${name}`, import.meta.url);
const encode = (value: unknown) =>
	JSON.stringify(value, (_, item) =>
		item instanceof Uint8Array ? { folioBytes: Buffer.from(item).toString('base64') } : item
	);

export function prepareProbe() {
	const source = readFileSync(build('fixture.wasm'));
	const prepared = prepare(source);
	assert.ok(prepared.transactional && prepared.loops.program, 'missing compiler path');
	const { loops, native, reasons } = prepared;
	writeFileSync(
		build('probe.json'),
		JSON.stringify({
			loops,
			native,
			reasons,
			original: Buffer.from(prepared.original).toString('base64'),
			transactional: Buffer.from(prepared.transactional).toString('base64'),
			sha256: createHash('sha256').update(source).digest('hex')
		})
	);
}

export function prepareControl() {
	const source = readFileSync(build('generalized.wasm'));
	const prepared = prepare(source);
	const control = prepared.control;
	assert.ok(control);
	assert.ok(control.entries.includes('main'));
	assert.equal(prepared.loops.main, undefined);
	writeFileSync(build('control-prepared.json'), encode(prepared));
	console.log(
		JSON.stringify({
			originalBytes: source.length,
			controlRegions: control.regions.length,
			entries: control.entries
		})
	);
}

if (import.meta.main) {
	prepareProbe();
	prepareControl();
}
