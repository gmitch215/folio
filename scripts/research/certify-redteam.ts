import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { certifyStream } from '../../src/certify.ts';
import { groundTruth } from './certify-ground.ts';

// the stream certifier over a red team run directory (see redteam/run.ts), with ground truth by execution
// usage: certify-redteam.ts RUN_DIRECTORY MODULES.json OUTPUT.json
//   MODULES.json is the recorded red team table, which says which modules are valid affine functions

const [dir, modulesPath, target] = process.argv.slice(2);
if (!dir || !modulesPath || !target)
	throw new Error('usage: certify-redteam.ts RUN_DIRECTORY MODULES.json OUTPUT.json');
if (existsSync(target)) throw new Error(`refusing to overwrite ${target}`);

const recorded = JSON.parse(readFileSync(modulesPath, 'utf8')) as {
	id: string;
	group: string;
	validAffine: 'gf2' | 'z2w' | 'no';
}[];
const validity = new Map(recorded.map((r) => [r.id.replace(/\//g, '-') + '.wasm', r]));

/** Refusals that follow from what a stream function is allowed to touch, not from a missing operation. */
const OUTSIDE: [RegExp, string][] = [
	[
		/unsupported expression kind|unsupported operation \d/,
		'state held in linear memory, globals or tables'
	],
	[
		/start function|has imports|passive data|shared or 64-bit|not a valid module/,
		'module features'
	],
	[/store/, 'writes memory while it folds'],
	[/control value|control values|of a control/, 'pointer or length used as data'],
	[/low bits set|splits the symbolic bits/, 'depends on the pointer alignment'],
	[/folded bytes differ|reads past its byte/, 'reads outside its input']
];
const outside = (reason: string) => OUTSIDE.find(([pattern]) => pattern.test(reason))?.[1];

const files = ['build', 'clang']
	.map((d) => join(dir, d))
	.filter(existsSync)
	.flatMap((d) =>
		readdirSync(d)
			.filter((f) => f.endsWith('.wasm'))
			.sort()
			.map((f) => join(d, f))
	);

const rows: object[] = [];
const seen = new Set<string>();
const tally: Record<string, number> = {};
const bump = (key: string) => (tally[key] = (tally[key] ?? 0) + 1);
const LENGTHS = [1, 2, 15, 16, 17, 63, 64, 65, 1000, 4097, 65537, 262144];
for (const file of files) {
	const name = file.split('/').pop()!;
	const bytes = new Uint8Array(readFileSync(file));
	const sha = createHash('sha256').update(bytes).digest('hex');
	const meta = validity.get(name);
	const result = certifyStream(bytes, 'update');
	const row: Record<string, unknown> = {
		module: name,
		moduleSha256: sha,
		group: meta?.group,
		recordedValid: meta?.validAffine
	};
	if (result.kind === 'certificate') {
		row.verdict = 'certified';
		row.ring = result.ring;
		let failure = '';
		try {
			failure = groundTruth(bytes, result, LENGTHS, 1 << 20);
		} catch (error) {
			failure = `harness: ${String(error).slice(0, 80)}`;
		}
		row.groundTruth = failure || 'agrees';
		bump(failure ? 'ACCEPTED-AND-WRONG' : 'certified');
	} else {
		row.verdict = 'refused';
		row.reason = result.reason;
		const ring = meta?.validAffine === 'z2w' ? 'z2w' : 'gf2';
		const reason = result.attempts.find((a) => a.ring === ring)?.reason ?? result.reason;
		row.reasonForRing = reason;
		if (meta === undefined) row.category = 'unclassified';
		else if (meta.validAffine === 'no') row.category = 'correct refusal';
		else
			row.category = outside(reason)
				? `outside the class: ${outside(reason)}`
				: 'eligible, not certified';
		bump(String(row.category));
	}
	seen.add(sha);
	rows.push(row);
}
writeFileSync(
	target,
	JSON.stringify(
		{
			kind: 'certifier-redteam',
			node: process.version,
			modules: rows.length,
			distinct: seen.size,
			tally,
			rows
		},
		null,
		2
	) + '\n'
);
console.log(JSON.stringify({ modules: rows.length, distinct: seen.size, tally }, null, 1));
