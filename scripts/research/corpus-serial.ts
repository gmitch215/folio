import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { measure } from '../probe/consumer.ts';
import { corpusConsumer } from './cases/upstream.ts';
import { corpusManifest } from './corpus.ts';
import { researchEnvironment } from './environment.ts';

if (import.meta.main) {
	const [directory, pairsArg = '9', ...selected] = process.argv.slice(2),
		pairs = Number(pairsArg);
	if (!directory || !Number.isSafeInteger(pairs) || pairs < 1)
		throw new Error('usage: corpus-serial.ts OUTPUT_DIRECTORY [PAIRS]');
	if (selected.some((id) => !corpusManifest.cases.some((item) => item.id === id)))
		throw new Error('unknown corpus case');
	mkdirSync(directory, { recursive: true });
	const raw = join(directory, 'raw.jsonl');
	writeFileSync(raw, '', { flag: 'wx' });
	const sink = (row: Record<string, unknown>) => appendFileSync(raw, JSON.stringify(row) + '\n');
	const minimumRegionWork = process.env.FOLIO_CORPUS_ADMISSION === '0' ? 0 : undefined;
	sink(
		researchEnvironment({
			pairs,
			widths: [1, 2, 4, 8],
			minimumRegionWork,
			scope: 'one upstream entry; verification outside timing'
		})
	);
	for (const kernel of corpusManifest.cases.filter(
		(item) => !selected.length || selected.includes(item.id)
	)) {
		await measure(corpusConsumer(kernel.id), {
			pairs,
			warmup: 2,
			widths: [1, 2, 4, 8],
			minimumRegionWork,
			sink: (row) => sink({ ...row, case: kernel.id })
		});
		console.log(kernel.id);
	}
}
