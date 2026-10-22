import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { openContexts, type Contexts, type SqlStatement } from './php-contexts.ts';
import { seedCode } from './php-regen.ts';

// SQL census of Drupal write workloads: one unit at a time in a private context, each unit
// bracketed by sqlLog start and take. Two fresh contexts run the same sequence, so the statement
// shapes can be compared across passes.
// usage: node scripts/probe/php-sql-census.ts OUTPUT.jsonl [UNITS]
// FOLIO_CONSUMER, FOLIO_WORKER_BUNDLE, FOLIO_MACHINE as in php-regen.ts

const prelude = `<?php
use Drupal\\node\\Entity\\Node;
use Drupal\\user\\Entity\\User;
use Drupal\\taxonomy\\Entity\\Term;
foreach (['SAVED_NEW' => 1, 'SAVED_UPDATED' => 2, 'SAVED_DELETED' => 3] as $name => $value) {
	if (!defined($name)) define($name, $value);
}
$body = str_repeat('<p>Census fixture paragraph with <a href="/">a link</a> and <em>emphasis</em>.</p>', 4);
`;

const preflightCode = `<?php
$taxonomy = \\Drupal::moduleHandler()->moduleExists('taxonomy');
$tags = $taxonomy && \\Drupal::entityTypeManager()->getStorage('taxonomy_vocabulary')->load('tags') !== NULL;
echo json_encode(['taxonomy' => $taxonomy, 'tags' => $tags]);
`;

const cronCode = `<?php
\\Drupal::service('cron')->run();
echo json_encode(['ok' => true]);
`;

// one PHP snippet per unit; i is the unit index (1-based)
export const units = {
	'node-save': (i: number) => `${prelude}
$node = Node::create([
	'type' => 'page',
	'title' => 'Census save ${i}',
	'body' => ['value' => $body, 'format' => 'basic_html'],
	'status' => 1,
	'uid' => 1,
	'created' => 1760000000,
	'changed' => 1760000000
]);
$node->save();
echo json_encode(['id' => (int) $node->id()]);
`,
	'node-update': (i: number, nid: number) => `${prelude}
$node = Node::load(${nid});
$node->setTitle('Census updated ${i}');
$node->set('body', ['value' => $body, 'format' => 'basic_html']);
$node->setChangedTime(1760000100);
$node->save();
echo json_encode(['id' => (int) $node->id()]);
`,
	'user-create': (i: number) => `${prelude}
$user = User::create([
	'name' => 'census user ${i}',
	'mail' => 'census-user-${i}@example.com',
	'status' => 1,
	'pass' => 'census-pass'
]);
$user->save();
echo json_encode(['id' => (int) $user->id()]);
`,
	'term-create': (i: number) => `${prelude}
$term = Term::create(['vid' => 'tags', 'name' => 'census term ${i}']);
$term->save();
echo json_encode(['id' => (int) $term->id()]);
`
};

export const workloadOrder = [
	'node-save',
	'node-update',
	'user-create',
	'term-create',
	'render',
	'cron'
];

/** statement count, SQL time and verb tally of one unit's statements */
export function tally(statements: SqlStatement[]) {
	const verbs: Record<string, number> = {};
	for (const s of statements) {
		const verb = s.text.trim().split(/\s+/)[0]!.toUpperCase();
		verbs[verb] = (verbs[verb] ?? 0) + 1;
	}
	return {
		statements: statements.length,
		sqlMs: statements.reduce((sum, s) => sum + s.ms, 0),
		verbs
	};
}

/** runs one unit between sqlLog start and take; the statements come back with its value */
async function logged<T>(contexts: Contexts, work: () => Promise<T>) {
	await contexts.sqlLog(0, 'start');
	let value: T;
	let statementsLog: SqlStatement[];
	try {
		value = await work();
	} finally {
		statementsLog = await contexts.sqlLog(0, 'take');
	}
	return { value, statementsLog };
}

/** resolves to 'timeout' after ms; the timer is cleared when the race ends */
function withTimeout<T>(promise: Promise<T>, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<'timeout'>((done) => {
		timer = setTimeout(() => done('timeout'), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** one fresh context; returns true when a unit hung and the context cannot be closed */
async function pass(
	index: number,
	options: { consumer: string; bundle?: string; count: number },
	emit: (row: object) => void
) {
	const contexts = await openContexts({
		count: 1,
		kind: 'drupal',
		mode: 'native',
		bundle: options.bundle,
		consumer: options.consumer
	});
	const seeded = (await contexts.runAll(seedCode(options.count), undefined, true))[0]!;
	const ids = JSON.parse(seeded.output!).ids as number[];
	const preflight = JSON.parse((await contexts.run(0, preflightCode, true)).output!);
	emit({ kind: 'preflight', pass: index, seededNodes: ids, drupal: preflight });

	const plan: [string, boolean][] = [
		['node-save', true],
		['node-update', true],
		['user-create', true],
		['term-create', preflight.tags === true],
		['render', true],
		['cron', true]
	];
	const unitRow = (workload: string, unit: number, row: object) =>
		emit({ kind: 'unit', pass: index, workload, unit, ...row });
	let hung = false;
	for (const [workload, enabled] of plan) {
		if (!enabled) {
			emit({ kind: 'dropped', pass: index, workload, reason: 'no tags vocabulary in seed' });
			continue;
		}
		const rows: [number, object][] = [];
		try {
			if (workload === 'cron') {
				// a hung cron leaves the context busy, so its sqlLog take is never answered
				await contexts.sqlLog(0, 'start');
				const outcome = await withTimeout(
					contexts.run(0, cronCode, true).then(
						(run) => ({ status: 'finished', wallMs: run.endMs - run.startMs }),
						(error) => ({ status: 'error', error: String(error.message).slice(0, 500) })
					),
					120_000
				);
				if (outcome === 'timeout') {
					hung = true;
					rows.push([1, { status: 'timeout', statements: null }]);
					break;
				}
				const statementsLog = await contexts.sqlLog(0, 'take');
				rows.push([1, { ...outcome, ...tally(statementsLog), statementsLog }]);
			} else {
				for (let unit = 1; unit <= options.count; unit++) {
					const { value, statementsLog } = await logged(contexts, () =>
						workload === 'render'
							? contexts
									.render([0], {
										path: `/node/${ids[unit - 1]}`,
										bins: ['page', 'dynamic_page_cache', 'render']
									})
									.then((runs) => runs[0]!)
							: contexts.run(
									0,
									units[workload as keyof typeof units](unit, ids[unit - 1]!),
									true
								)
					);
					rows.push([
						unit,
						{
							...(workload === 'render' ? { path: `/node/${ids[unit - 1]}` } : {}),
							wallMs: value.endMs - value.startMs,
							...tally(statementsLog),
							statementsLog
						}
					]);
				}
			}
		} catch (error) {
			emit({
				kind: 'dropped',
				pass: index,
				workload,
				reason: String((error as Error)?.message ?? error).slice(0, 500)
			});
			continue;
		}
		for (const [unit, row] of rows) unitRow(workload, unit, row);
	}
	if (hung) return true;
	await contexts.close();
	return false;
}

async function main(output: string, args: string[]) {
	const count = Number(args[0] ?? 8);
	const consumer = resolve(
		process.env.FOLIO_CONSUMER ?? new URL('../../../drupflare/worker', import.meta.url).pathname
	);
	const lines: string[] = [];
	const emit = (row: object) => {
		lines.push(JSON.stringify(row));
		writeFileSync(output, lines.join('\n') + '\n');
	};
	emit({
		kind: 'environment',
		experiment: 'SQL census of Drupal write workloads, one context at a time',
		machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
		node: process.version,
		cpu: cpus()[0]!.model,
		units: count,
		workloads: workloadOrder,
		passes: 2
	});
	let hung = false;
	for (let index = 1; index <= 2; index++) {
		const bundle = process.env.FOLIO_WORKER_BUNDLE;
		hung = (await pass(index, { consumer, bundle, count }, emit)) || hung;
	}
	if (hung) process.exit(0);
}

if (import.meta.main) {
	const [output, ...args] = process.argv.slice(2);
	if (!output) throw new Error('usage: php-sql-census.ts OUTPUT.jsonl [UNITS]');
	await main(output, args);
}
