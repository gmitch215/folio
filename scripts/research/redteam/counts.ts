import { readFileSync, writeFileSync } from 'node:fs';
import { moduleBytes, relocation, type Row } from './lib.ts';

// final classification: a refused valid function that is not address independent is a correct refusal
const dir = process.argv[2];
if (!dir) throw new Error('usage: counts.ts DIRECTORY');
const rows: Row[] = JSON.parse(readFileSync(`${dir}/modules.json`, 'utf8'));
const formOf = (id: string) => (/loop$/.test(id) ? 'loop' : 'stream');
const sha = new Set<string>();
const tally: Record<string, Record<string, number>> = {
	stream: {},
	loop: {},
	streamInForm: {},
	loopInForm: {}
};
const causes: Record<string, Record<string, string[]>> = { stream: {}, loop: {} };
const addressDependent: string[] = [];
const anyWrong: string[] = [];
for (const r of rows) {
	sha.add(r.moduleSha256!);
	let valid = r.validAffine;
	if (
		valid !== 'no' &&
		!r.stream.accepted &&
		!r.loop.accepted &&
		relocation(moduleBytes(dir, r.id))
	) {
		valid = 'no';
		addressDependent.push(r.id);
	}
	for (const k of ['stream', 'loop'] as const) {
		let c: string;
		const v = r[k];
		if (v.accepted)
			c =
				r.truth.composes && !v.modelFailure && !r.relocation
					? 'accepted-correct'
					: 'ACCEPTED-WRONG';
		else
			c =
				valid === 'gf2'
					? 'FALSE-REFUSAL'
					: valid === 'z2w'
						? 'refused-valid-z2w-out-of-class'
						: 'correct-refusal';
		if (c === 'ACCEPTED-WRONG') anyWrong.push(`${r.id} ${k}`);
		tally[k]![c] = (tally[k]![c] ?? 0) + 1;
		if (formOf(r.id) === k) {
			tally[k + 'InForm']![c] = (tally[k + 'InForm']![c] ?? 0) + 1;
			if (c === 'FALSE-REFUSAL' || c === 'refused-valid-z2w-out-of-class') {
				const key = `${c} | ${v.reason.replace(/\d+/g, 'N')}`;
				(causes[k]![key] ??= []).push(r.id);
			}
		}
	}
}
const out = {
	modules: rows.length,
	distinctBinaries: sha.size,
	tally,
	addressDependent,
	anyWrong,
	causes: Object.fromEntries(
		Object.entries(causes).map(([k, v]) => [
			k,
			Object.fromEntries(
				Object.entries(v).map(([c, ids]) => [
					c,
					{ n: ids.length, examples: ids.slice(0, 5) }
				])
			)
		])
	)
};
writeFileSync(`${dir}/counts.json`, JSON.stringify(out, null, 1), { flag: 'wx' });
console.log(
	JSON.stringify(
		{
			modules: out.modules,
			distinctBinaries: out.distinctBinaries,
			tally,
			addressDependent,
			anyWrong
		},
		null,
		1
	)
);
