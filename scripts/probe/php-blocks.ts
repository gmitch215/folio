import { writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { parseStatement } from '../analyze/sqlcensus.ts';
import { openContexts, type Contexts, type SqlStatement } from './php-contexts.ts';
import { seedCode } from './php-regen.ts';

// warm block cost of one uncached anonymous page render: one private Drupal context, N cloned
// blocks in the active theme, measured renders bracketed by PHP event marks, and each block built
// alone with its render cache emptied.
// usage: node scripts/probe/php-blocks.ts OUTPUT.jsonl [COUNTS]
// FOLIO_CONSUMER, FOLIO_WORKER_BUNDLE, FOLIO_MACHINE as in php-regen.ts

const warmups = 5;
const measured = 20;
const repeats = 20;
const pageNodes = 6;
const bins = ['page', 'dynamic_page_cache', 'render'];
const preferredPlugins = [
	'system_branding_block',
	'system_powered_block',
	'system_menu_block:main',
	'system_breadcrumb_block',
	'system_messages_block',
	'local_tasks_block',
	'search_form_block'
];

const phpList = (values: string[]) => `[${values.map((v) => `'${v}'`).join(', ')}]`;

// block saves and renders need a current request; the CLI-style context has none
const requestStack = `use Symfony\\Component\\HttpFoundation\\Request;
\\Drupal::requestStack()->push(Request::create('/'));`;

const listenersCode = `<?php
use Drupal\\Core\\Render\\RenderEvents;
use Symfony\\Component\\HttpKernel\\KernelEvents;
if (empty($GLOBALS['folio_listeners'])) {
	$GLOBALS['folio_listeners'] = true;
	$dispatcher = \\Drupal::service('event_dispatcher');
	$dispatcher->addListener(KernelEvents::REQUEST, function () {
		$GLOBALS['folio_marks'] = ['request' => hrtime(true)];
	}, 1000000);
	$dispatcher->addListener(RenderEvents::SELECT_PAGE_DISPLAY_VARIANT, function () {
		$GLOBALS['folio_marks']['variant'] = hrtime(true);
	}, 1000000);
	$dispatcher->addListener(KernelEvents::RESPONSE, function () {
		$GLOBALS['folio_marks']['response'] = hrtime(true);
	}, -1000000);
}
echo json_encode(['listeners' => true]);
`;

const marksCode = `<?php
echo json_encode($GLOBALS['folio_marks'] ?? null);
`;

const environmentCode = `<?php
$modules = array_keys(\\Drupal::moduleHandler()->getModuleList());
sort($modules);
$theme = \\Drupal::config('system.theme')->get('default');
$defs = array_keys(\\Drupal::service('plugin.manager.block')->getDefinitions());
sort($defs);
$info = \\Drupal::service('theme_handler')->getTheme($theme)->info;
echo json_encode([
	'modules' => $modules,
	'theme' => $theme,
	'regions' => array_keys($info['regions'] ?? []),
	'blockPlugins' => $defs
]);
`;

// keeps the main content and page title blocks, disables the rest, then places ${count} clones
export const placeCode = (count: number, plugins: string[]) => `<?php
${requestStack}
use Drupal\\block\\Entity\\Block;
$theme = \\Drupal::config('system.theme')->get('default');
$manager = \\Drupal::service('plugin.manager.block');
$defs = $manager->getDefinitions();
$plugins = array_values(array_filter(${phpList(plugins)}, fn($p) => isset($defs[$p])));
$keep = ['system_main_block', 'page_title_block'];
foreach (Block::loadMultiple() as $block) {
	if ($block->getTheme() !== $theme) continue;
	if (str_starts_with($block->id(), 'folio_clone_')) {
		$block->delete();
		continue;
	}
	if (in_array($block->getPluginId(), $keep, true)) $block->enable()->save();
	else $block->disable()->save();
}
for ($i = 1; $i <= ${count}; $i++) {
	$plugin = $plugins[($i - 1) % count($plugins)];
	$settings = $manager->createInstance($plugin)->getConfiguration();
	$settings['label_display'] = '0';
	Block::create([
		'id' => 'folio_clone_' . $i,
		'theme' => $theme,
		'region' => 'content',
		'plugin' => $plugin,
		'weight' => $i,
		'settings' => $settings,
		'visibility' => []
	])->save();
}
$enabled = [];
foreach (Block::loadMultiple() as $block) {
	if ($block->getTheme() === $theme && $block->status()) $enabled[] = $block->getPluginId();
}
sort($enabled);
echo json_encode(['theme' => $theme, 'clonePlugins' => $plugins, 'enabledPlugins' => $enabled]);
`;

// every enabled block of the theme: 20 builds each with the render cache emptied first
export const isolatedCode = `<?php
${requestStack}
use Drupal\\block\\Entity\\Block;
$theme = \\Drupal::config('system.theme')->get('default');
$view = \\Drupal::entityTypeManager()->getViewBuilder('block');
$renderer = \\Drupal::service('renderer');
$cache = \\Drupal::cache('render');
$out = [];
foreach (Block::loadMultiple() as $block) {
	if ($block->getTheme() !== $theme || !$block->status()) continue;
	$ms = [];
	$bytes = 0;
	for ($r = 0; $r < ${repeats}; $r++) {
		$cache->deleteAll();
		$t = hrtime(true);
		$html = $renderer->renderInIsolation($view->view($block));
		$ms[] = (hrtime(true) - $t) / 1e6;
		$bytes = strlen((string) $html);
	}
	$out[] = ['id' => $block->id(), 'plugin' => $block->getPluginId(), 'bytes' => $bytes, 'ms' => $ms];
}
echo json_encode($out);
`;

const writesOf = (statements: SqlStatement[]) => {
	const tables = new Set<string>();
	for (const s of statements) for (const t of parseStatement(s.text).writeTables) tables.add(t);
	return [...tables].sort();
};

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** one measured render with the event marks and the SQL it wrote */
async function renderRow(contexts: Contexts, nid: number) {
	await contexts.sqlLog(0, 'start');
	const run = (await contexts.render([0], { path: `/node/${nid}`, bins }))[0]!;
	const statements = await contexts.sqlLog(0, 'take');
	const marks = JSON.parse((await contexts.run(0, marksCode, true)).output!) as Record<
		string,
		number
	> | null;
	if (!marks?.request || !marks.variant || !marks.response)
		throw new Error('event marks missing: ' + JSON.stringify(marks));
	const ms = (from: number, to: number) => (to - from) / 1e6;
	return {
		node: nid,
		wallMs: run.endMs - run.startMs,
		variantMs: ms(marks.request, marks.variant),
		responseMs: ms(marks.request, marks.response),
		eventToResponseMs: ms(marks.variant, marks.response),
		bytes: run.bytes,
		sha256: run.sha256,
		sqlMs: sum(statements.map((s) => s.ms)),
		statements: statements.length,
		writeTables: writesOf(statements)
	};
}

async function main(output: string, args: string[]) {
	const counts = (args[0] ?? '0,10,20,40').split(',').map(Number);
	const consumer = resolve(
		process.env.FOLIO_CONSUMER ?? new URL('../../../drupflare/worker', import.meta.url).pathname
	);
	const lines: string[] = [];
	const emit = (row: object) => {
		lines.push(JSON.stringify(row));
		writeFileSync(output, lines.join('\n') + '\n');
	};
	const contexts = await openContexts({
		count: 1,
		kind: 'drupal',
		mode: 'native',
		bundle: process.env.FOLIO_WORKER_BUNDLE,
		consumer
	});
	const seeded = (await contexts.runAll(seedCode(pageNodes), undefined, true))[0]!;
	const nodes = JSON.parse(seeded.output!).ids as number[];
	await contexts.run(0, listenersCode, true);
	const env = JSON.parse((await contexts.run(0, environmentCode, true)).output!);
	emit({
		kind: 'environment',
		experiment: 'warm block cost of one uncached anonymous Drupal render',
		machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
		node: process.version,
		cpu: cpus()[0]!.model,
		hardwareThreads: cpus().length,
		load: loadavg(),
		counts,
		warmups,
		measured,
		repeats,
		nodes,
		preferredPlugins,
		...env
	});

	for (const count of counts) {
		const fixture = JSON.parse(
			(await contexts.run(0, placeCode(count, preferredPlugins), true)).output!
		);
		emit({ kind: 'fixture', blocks: count, ...fixture });
		const nodeFor = (i: number) => nodes[i % nodes.length]!;
		for (let i = 0; i < warmups; i++) await renderRow(contexts, nodeFor(i));
		for (let i = 0; i < measured; i++) {
			const row = await renderRow(contexts, nodeFor(i));
			emit({ kind: 'render', blocks: count, round: i, ...row });
		}
		await contexts.sqlLog(0, 'start');
		const blocks = JSON.parse((await contexts.run(0, isolatedCode, true)).output!);
		const statements = await contexts.sqlLog(0, 'take');
		emit({
			kind: 'isolated',
			blocks: count,
			writeTables: writesOf(statements),
			statements: statements.length,
			perBlock: blocks
		});
	}
	await contexts.close();
}

if (import.meta.main) {
	const [output, ...args] = process.argv.slice(2);
	if (!output) throw new Error('usage: php-blocks.ts OUTPUT.jsonl [COUNTS]');
	await main(output, args);
}
