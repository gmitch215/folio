import { readFileSync, writeFileSync } from 'node:fs';

type Row = Record<string, any>;
const lines = (path: string) =>
	readFileSync(path, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as Row);
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Row;

/** Counts kernels that clear a speedup bar for one arm of a paired summary. */
export function speedupCounts(summary: Row, arm: string, bars: number[]) {
	const medians = Object.values(summary.groups as Record<string, Row>).map(
		(group) => group[arm].pairedSpeedup.median as number
	);
	return {
		kernels: medians.length,
		...Object.fromEntries(
			bars.map((bar) => [`atLeast${bar}x`, medians.filter((value) => value >= bar).length])
		)
	};
}

/** One table of denominators: what was built, what the default route did, and what ran faster. */
export function denominators(root: string) {
	const upstream = lines(`${root}/upstream/raw.jsonl`);
	const kernels = upstream.filter((row) => row.kind === 'build');
	const inspect = upstream.filter((row) => row.kind === 'inspect');
	const defaultEntry = json(`${root}/default-entry-repeat/ryzen.summary.json`);
	const forced = json(`${root}/forced-admission-complete/summary.json`);
	const speculative = Object.entries(forced.groups as Record<string, Row>).filter(([, group]) =>
		group['folio-8'].modes.includes('speculative')
	);
	const policies = Object.fromEntries(
		['whole', 'pages', 'checkpoint'].flatMap((policy) =>
			['ryzen', 'm2'].map((machine) => [
				`${machine}-${policy}`,
				speedupCounts(
					json(`${root}/reset-policies/${machine}-${policy}.summary.json`),
					'tasks-8-batched',
					[1, 2, 3]
				)
			])
		)
	);
	const inputs = lines(`${root}/varied-inputs/raw.jsonl`).filter(
		(row) => row.kind === 'comparison'
	);
	return {
		schema: 'folio.denominators.v1',
		scope: 'library kernels, not full applications',
		projects: upstream.filter((row) => row.kind === 'source').length,
		kernels: kernels.length,
		built: kernels.filter((row) => row.artifactSha256).length,
		nativeMatch: upstream.filter((row) => row.kind === 'comparison' && row.passed).length,
		defaultAdmission: {
			inspected: inspect.length,
			withAutomaticPlan: inspect.filter(
				(row) => row.loops.length || row.native.length || row.controlEntries.length
			).length,
			dispatchedWorkers: Object.values(defaultEntry.groups as Record<string, Row>).filter(
				(group) => group['folio-8'].workers.some((count: number) => count > 0)
			).length
		},
		forcedAdmission: {
			completed: Object.keys(forced.groups).length,
			speculative: speculative.length,
			speculativeFasterThanNative: speculative.filter(
				([, group]) => group['folio-8'].pairedSpeedup.median > 1
			).length
		},
		explicitTasksEightWorkersBatched: policies,
		variedInputs: {
			comparisons: inputs.length,
			passed: inputs.filter((row) => row.passed).length
		},
		fullApplications: 0
	};
}

const labels: Record<string, string> = {
	'lz4-compress': 'LZ4 compress',
	'lz4-decompress': 'LZ4 decompress',
	'miniz-compress': 'miniz compress',
	'miniz-decompress': 'miniz decompress',
	'miniz-crc32': 'miniz CRC-32',
	'miniz-adler32': 'miniz Adler-32',
	'jsmn-parse': 'jsmn parse',
	'kissfft-complex': 'KissFFT complex',
	'kissfft-real': 'KissFFT real',
	'aes-cbc-encrypt': 'AES-CBC encrypt',
	'aes-cbc-decrypt': 'AES-CBC decrypt',
	'aes-ctr': 'AES-CTR',
	xxhash32: 'xxHash32',
	xxhash64: 'xxHash64',
	xxhash3: 'xxHash3',
	'qoi-encode': 'QOI encode',
	'qoi-decode': 'QOI decode',
	sha256: 'SHA-256',
	sha1: 'SHA-1',
	md5: 'MD5',
	m6502: '6502 emulator'
};

/** One row per kernel with every route measured on it: default entry, forced admission and the three reset policies. */
export function kernelResults(root: string) {
	const defaults = {
		ryzen: json(`${root}/default-entry-repeat/ryzen.summary.json`),
		m2: json(`${root}/default-entry-repeat/m2.summary.json`)
	};
	const forced = json(`${root}/forced-admission-complete/summary.json`);
	const policies = ['whole', 'pages', 'checkpoint'];
	const reset = Object.fromEntries(
		['ryzen', 'm2'].flatMap((machine) =>
			policies.map((policy) => [
				`${machine}-${policy}`,
				json(`${root}/reset-policies/${machine}-${policy}.summary.json`)
			])
		)
	);
	const names = Object.keys(defaults.ryzen.groups);
	return {
		schema: 'folio.kernel-results.v1',
		scope: 'library kernels, eight workers, paired median over native; tasks are batched TaskPool workers',
		kernels: names.map((kernel) => {
			const wide = forced.groups[kernel]?.['folio-8'];
			return {
				kernel,
				label: labels[kernel] ?? kernel,
				nativeMs: defaults.ryzen.groups[kernel].native.wallMs.median as number,
				defaultEntry: Object.fromEntries(
					Object.entries(defaults).map(([machine, summary]) => [
						machine,
						summary.groups[kernel]['folio-8'].pairedSpeedup.median as number
					])
				),
				forcedAdmission: wide?.modes.includes('speculative')
					? { route: 'speculative', speedup: wide.pairedSpeedup.median as number }
					: { route: 'serial' },
				tasks: Object.fromEntries(
					Object.entries(reset).map(([key, summary]) => {
						const arm = summary.groups[kernel]['tasks-8-batched'];
						return [
							key,
							{
								speedup: arm.pairedSpeedup.median as number,
								cpuRatio: arm.cpuRatio.median as number
							}
						];
					})
				)
			};
		})
	};
}

/** Renders the kernel rows as the markdown table the study README and the technical report share. */
export function kernelTable(result: ReturnType<typeof kernelResults>) {
	const two = (value: number) => value.toFixed(2);
	const pair = (ryzen: number, m2: number) => `${two(ryzen)} / ${two(m2)}`;
	const forced = (row: (typeof result.kernels)[number]) =>
		row.forcedAdmission.route === 'serial'
			? 'serial'
			: `${Math.round(1 / row.forcedAdmission.speedup!).toLocaleString('en-US')}x slower`;
	const lines = [
		'| Kernel | Native ms | Default entry | Forced admission | Whole arena | Learned pages | Checkpoint |',
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
	];
	for (const row of result.kernels) {
		const task = (policy: string) =>
			pair(row.tasks[`ryzen-${policy}`]!.speedup, row.tasks[`m2-${policy}`]!.speedup);
		lines.push(
			`| ${row.label} | ${row.nativeMs.toFixed(2)} | ${pair(row.defaultEntry.ryzen!, row.defaultEntry.m2!)} | ${forced(row)} | ${task('whole')} | ${task('pages')} | ${task('checkpoint')} |`
		);
	}
	return lines.join('\n') + '\n';
}

if (import.meta.main) {
	const [root, output, kernels] = process.argv.slice(2);
	if (!root || !output)
		throw new Error(
			'usage: denominators.ts RESULTS_CORPUS_DIRECTORY OUTPUT.json [KERNELS_DIRECTORY]'
		);
	const result = denominators(root);
	writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
	console.log(JSON.stringify(result.defaultAdmission));
	if (kernels) {
		const rows = kernelResults(root);
		writeFileSync(`${kernels}/kernels.json`, JSON.stringify(rows, null, 2) + '\n');
		writeFileSync(`${kernels}/kernels.md`, kernelTable(rows));
		console.log(JSON.stringify({ kernels: rows.kernels.length }));
	}
}
