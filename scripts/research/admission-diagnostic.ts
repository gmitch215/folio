import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { corpusManifest } from './corpus.ts';
import { digest, researchEnvironment } from './environment.ts';

if (import.meta.main) {
	const [directory, secondsArg = '60'] = process.argv.slice(2),
		seconds = Number(secondsArg);
	if (!directory || !Number.isSafeInteger(seconds) || seconds < 1)
		throw new Error('usage: admission-diagnostic.ts OUTPUT_DIRECTORY [SECONDS_PER_CASE]');
	mkdirSync(directory, { recursive: true });
	const index = join(directory, 'index.json');
	writeFileSync(index, '', { flag: 'wx' });
	const rows: Record<string, unknown>[] = [];
	const environment = researchEnvironment({
		minimumRegionWork: 0,
		pairs: 3,
		warmup: 2,
		secondsPerCase: seconds,
		performanceClaim: false
	});
	for (const kernel of corpusManifest.cases) {
		const target = join(directory, kernel.id);
		const result = spawnSync(
			process.execPath,
			[
				'--max-old-space-size=128',
				'scripts/research/corpus-serial.ts',
				target,
				'3',
				kernel.id
			],
			{
				env: { ...process.env, FOLIO_CORPUS_ADMISSION: '0' },
				timeout: seconds * 1000,
				killSignal: 'SIGTERM',
				maxBuffer: 1048576
			}
		);
		writeFileSync(
			join(directory, `${kernel.id}.log`),
			String(result.stdout ?? '') + String(result.stderr ?? '')
		);
		let records: Record<string, any>[] = [];
		try {
			records = readFileSync(join(target, 'raw.jsonl'), 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
		} catch {}
		rows.push({
			case: kernel.id,
			exitCode: result.status,
			signal: result.signal,
			error: result.error?.message,
			complete: records.some((row) => row.kind === 'closed'),
			samples: records.filter((row) => row.kind === 'sample').length,
			coverage: records.find((row) => row.kind === 'closed')?.coverage,
			rawSha256: records.length ? digest(readFileSync(join(target, 'raw.jsonl'))) : undefined
		});
		writeFileSync(
			index,
			JSON.stringify(
				{ environment, cases: rows, finished: rows.length === corpusManifest.cases.length },
				null,
				2
			) + '\n'
		);
		console.log(JSON.stringify(rows.at(-1)));
	}
}
