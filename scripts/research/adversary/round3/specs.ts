import { readSpecs, type Spec } from './lib.ts';
import { cSpecs } from './specs-c.ts';
import { wSpecs } from './specs-w.ts';

// the written families, then the generated ones in the order of the shard split
const generated = ['mutants.json', 'rnd.json', 'extra.json', 'extra2.json'];

export function allSpecs(): Spec[] {
	const out = [...cSpecs, ...wSpecs];
	for (const name of generated) {
		try {
			out.push(...readSpecs(name));
		} catch {
			console.error(`missing specs/${name}: run the generator first`);
		}
	}
	return out;
}
