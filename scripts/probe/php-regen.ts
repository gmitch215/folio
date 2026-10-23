import { writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { consumerRoot } from './consumer-root.ts';
import { openContexts } from './php-contexts.ts';

// regenerating a set of pages: W private Drupal contexts pull urls from one queue and render them
// (width 1 is the serial baseline). Every render empties the page, dynamic page and render caches
// first, so it is a regeneration and not a reassembly.
// usage: node scripts/probe/php-regen.ts OUTPUT.jsonl [PAIRS] [WIDTHS] [NODES]
// FOLIO_CONSUMER, FOLIO_WORKER_BUNDLE, FOLIO_MACHINE, FOLIO_AFFINITY as in php-intra.ts

export const seedCode = (count: number) => `<?php
foreach (['SAVED_NEW' => 1, 'SAVED_UPDATED' => 2, 'SAVED_DELETED' => 3] as $name => $value) {
	if (!defined($name)) define($name, $value);
}
$storage = \\Drupal::entityTypeManager()->getStorage('node');
$ids = [];
$body = str_repeat('<p>Regeneration fixture paragraph with <a href="/">a link</a>, <em>emphasis</em> and enough text to give the formatter and the filters real work to do.</p>', 6);
for ($i = 1; $i <= ${count}; $i++) {
	$node = $storage->create([
		'type' => 'page',
		'title' => 'Folio page ' . $i,
		'body' => ['value' => $body, 'format' => 'basic_html'],
		'status' => 1,
		'promote' => 1,
		'uid' => 1,
		'created' => 1760000000 + $i,
		'changed' => 1760000000 + $i
	]);
	$node->save();
	$ids[] = (int) $node->id();
}
echo json_encode(['ids' => $ids]);
`;

export const pageList = (ids: number[]) => ['/', ...ids.map((id) => `/node/${id}`)];

/** width workers take the next url from one queue, in order, until it is empty */
export async function drain<T>(
	urls: string[],
	width: number,
	render: (worker: number, url: string) => Promise<T>
): Promise<{ url: string; value: T }[][]> {
	const queue = [...urls];
	return Promise.all(
		Array.from({ length: width }, async (_, worker) => {
			const share: { url: string; value: T }[] = [];
			for (let url = queue.shift(); url !== undefined; url = queue.shift())
				share.push({ url, value: await render(worker, url) });
			return share;
		})
	);
}

async function main(output: string, args: string[]) {
	const pairs = Number(args[0] ?? 10);
	const widths = (args[1] ?? '2,4,8').split(',').map(Number);
	const nodeCount = Number(args[2] ?? 30);
	const consumer = consumerRoot();
	const bundle = process.env.FOLIO_WORKER_BUNDLE;
	const lines: string[] = [];
	const emit = (row: object) => {
		lines.push(JSON.stringify(row));
		writeFileSync(output, lines.join('\n') + '\n');
	};
	const top = Math.max(...widths);
	const t0 = performance.now();
	const contexts = await openContexts({
		count: top,
		kind: 'drupal',
		mode: 'native',
		bundle,
		consumer
	});
	const openMs = performance.now() - t0;
	const seeded = await contexts.runAll(seedCode(nodeCount), undefined, true);
	const created = seeded.map((run) => JSON.parse(run.output!).ids as number[]);
	if (created.some((ids) => ids.join() !== created[0]!.join()))
		throw new Error('contexts created different node ids');
	const urls = pageList(created[0]!);
	emit({
		kind: 'environment',
		experiment: 'regeneration of a page set by private Drupal contexts',
		machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
		node: process.version,
		runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`,
		cpu: cpus()[0]!.model,
		hardwareThreads: cpus().length,
		affinity: process.env.FOLIO_AFFINITY,
		pairs,
		widths,
		pages: urls.length,
		contextsOpenMs: openMs,
		boots: contexts.boots.map((b) => b.boot)
	});
	const render = async (worker: number, url: string) => {
		const run = (await contexts.render([worker], { path: url }))[0]!;
		return { ms: run.endMs - run.startMs, sha256: run.sha256!, bytes: run.bytes! };
	};
	const warm = await Promise.all(
		Array.from({ length: top }, (_, worker) => render(worker, urls[1]!))
	);
	emit({ kind: 'warmup', firstRenderMs: warm.map((w) => w.ms) });
	const oracle = new Map<string, string>();
	const first = (await drain(urls, 1, render))[0]!;
	for (const { url, value } of first) oracle.set(url, value.sha256);
	emit({
		kind: 'oracle',
		perUrl: first.map(({ url, value }) => ({ url, ms: value.ms, bytes: value.bytes }))
	});
	const arms = [1, ...widths];
	for (let round = 0; round < pairs; round++) {
		for (let k = 0; k < arms.length; k++) {
			const width = arms[(k + round) % arms.length]!;
			const cpu0 = process.cpuUsage();
			const wall0 = performance.now();
			const done = await drain(urls, width, render);
			const wallMs = performance.now() - wall0;
			const cpu = process.cpuUsage(cpu0);
			const mismatched = done
				.flat()
				.filter(({ url, value }) => oracle.get(url) !== value.sha256)
				.map(({ url }) => url);
			if (mismatched.length)
				throw new Error(`width ${width}: output differs for ${mismatched}`);
			emit({
				kind: 'sample',
				round,
				arm: width === 1 ? 'serial' : `regen-${width}`,
				width,
				pages: urls.length,
				wallMs,
				busyMs: done.map((share) => share.reduce((sum, r) => sum + r.value.ms, 0)),
				pagesPerWorker: done.map((share) => share.length),
				processCpuMs: (cpu.user + cpu.system) / 1000,
				load: loadavg()
			});
		}
	}
	await contexts.close();
}

if (import.meta.main) {
	const [output, ...args] = process.argv.slice(2);
	if (!output) throw new Error('usage: php-regen.ts OUTPUT.jsonl [PAIRS] [WIDTHS] [NODES]');
	await main(output, args);
}
