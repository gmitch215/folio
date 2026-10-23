import { writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { consumerRoot } from './consumer-root.ts';
import { openContexts } from './php-contexts.ts';

// usage: node scripts/probe/php-snapshot.ts OUTPUT.jsonl [SAMPLES]
// can a PHP context be cloned by copying its Wasm memory into a second context that booted the
// same way, and what does the copy cost? Context A defines a function and a global; context B
// does not. After the copy B must run A's function and see A's global. Also times the copy for
// a Drupal context pair, where B then renders. Counting copy cost only; no parallel mechanism.
const [output, samplesArg] = process.argv.slice(2);
if (!output) throw new Error('usage: php-snapshot.ts OUTPUT.jsonl [SAMPLES]');
const samples = Number(samplesArg ?? 20);
const consumer = consumerRoot();
const bundle = process.env.FOLIO_WORKER_BUNDLE;
const lines: string[] = [];
const emit = (row: object) => {
	lines.push(JSON.stringify({ ...row, load: loadavg() }));
	writeFileSync(output, lines.join('\n') + '\n');
};
emit({
	kind: 'environment',
	machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
	node: process.version,
	cpu: cpus()[0]!.model,
	hardwareThreads: cpus().length,
	samples
});

const plain = await openContexts({ count: 2, kind: 'plain', mode: 'native', bundle, consumer });
await plain.run(
	0,
	'<?php function only_in_a(int $x): int { return $x * 2 + 1; } $GLOBALS["state"] = ["a" => 42, "s" => str_repeat("z", 100000)]; echo 1;'
);
const probe =
	'<?php echo function_exists("only_in_a") ? only_in_a(20) . ":" . $GLOBALS["state"]["a"] . ":" . strlen($GLOBALS["state"]["s"]) : "missing";';
const before = await plain.run(1, probe, true);
emit({ kind: 'plain-before', output: before.output });
for (let i = 0; i < samples; i++) {
	const copy = await plain.snapshot(0, 1);
	const after = await plain.run(1, probe, true);
	const [x, y] = [await plain.run(0, probe, true), after];
	emit({
		kind: 'plain-sample',
		round: i,
		...copy,
		afterOutput: after.output,
		ownerOutput: x.output,
		correct: after.output === x.output && after.output === '41:42:100000',
		firstRunMs: y.endMs - y.startMs
	});
}
await plain.close();

const drupal = await openContexts({ count: 2, kind: 'drupal', mode: 'native', bundle, consumer });
const first = await drupal.render([0]);
for (let i = 0; i < Math.min(samples, 5); i++) {
	const copy = await drupal.snapshot(0, 1);
	let outcome = 'rendered';
	let sha = '';
	try {
		const [r] = await drupal.render([1]);
		sha = r!.sha256 as string;
	} catch (error) {
		outcome = String((error as Error).message).slice(0, 300);
	}
	emit({
		kind: 'drupal-sample',
		round: i,
		...copy,
		outcome,
		sha256: sha,
		ownerSha256: first[0]!.sha256
	});
}
await drupal.close();
