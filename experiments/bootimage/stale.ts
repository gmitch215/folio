import { bodyHash, normalizeBody } from './hostboot-analyze.ts';

/** PHP the product runs through Drupal's own config and entity APIs; each prints one JSON object */
export const edits: Record<string, string> = {
	rename: `<?php \\Drupal::configFactory()->getEditable('system.site')->set('name', 'Renamed Site')->save();
echo json_encode(['name' => \\Drupal::config('system.site')->get('name')]);`,
	content: `<?php
\\Drupal::configFactory()->getEditable('block.block.olivero_powered')->set('settings.label', 'Edited Block')->set('settings.label_display', true)->save();
$node = \\Drupal\\node\\Entity\\Node::create(['type' => 'page', 'title' => 'Edit Node', 'status' => 1, 'promote' => 1, 'uid' => 0, 'body' => ['value' => 'Edit body text', 'format' => 'plain_text']]);
$node->save();
echo json_encode(['nid' => $node->id(), 'block' => \\Drupal::config('block.block.olivero_powered')->get('settings.label')]);`
};

edits.maintenance = `<?php \\Drupal::state()->set('system.maintenance_mode', TRUE);
echo json_encode(['maintenance' => \\Drupal::state()->get('system.maintenance_mode')]);`;
edits.alias = `<?php
$alias = \\Drupal\\path_alias\\Entity\\PathAlias::create(['path' => '/user/login', 'alias' => '/hostboot-alias', 'langcode' => 'und']);
$alias->save();
echo json_encode(['alias' => $alias->id()]);`;
edits.module = `<?php
\\Drupal::service('module_installer')->install(['history']);
echo json_encode(['history' => \\Drupal::moduleHandler()->moduleExists('history')]);`;
edits.theme = `<?php \\Drupal::configFactory()->getEditable('system.theme.global')->set('features.favicon', FALSE)->save();
echo json_encode(['favicon' => \\Drupal::config('system.theme.global')->get('features.favicon')]);`;
edits.themecolor = `<?php \\Drupal::configFactory()->getEditable('olivero.settings')->set('base_primary_color', '#ff2200')->save();
echo json_encode(['color' => \\Drupal::config('olivero.settings')->get('base_primary_color')]);`;
export const pathOf: Record<string, string> = { alias: '/hostboot-alias' };

export const markers = ['Renamed Site', 'Edit Node', 'Edited Block'] as const;

export interface StaleStep {
	step: string;
	status?: number;
	bytes?: number;
	hash?: string;
	markers?: string[];
	warm?: number;
	baked?: boolean;
	context?: string;
	note?: unknown;
}

const json = (text: string): any => {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
};

/** one arm, one case: migrate, seed, render, edit, render warm, drop the interpreter, render cold */
export async function runCase(base: string, site: string, edit: string, seed: string) {
	const steps: StaleStep[] = [];
	const get = async (path: string) =>
		(await fetch(`${base}${path}`, { signal: AbortSignal.timeout(170_000) })).text();
	const q = `site=${encodeURIComponent(site)}`;
	await get(`/migrate?${q}&all=1`);
	await get(`/migrate?${q}&all=1`);
	await get(`/hostseed?${q}&${seed}`);
	const render = async (step: string) => {
		const body = json(
			await get(`/hostbody?${q}&path=${encodeURIComponent(pathOf[edit] ?? '/')}`)
		);
		const run = body.php?.runs?.[0];
		const html: string = run?.body ?? '';
		steps.push({
			step,
			status: run?.status,
			bytes: run?.bytes,
			hash: html ? bodyHash(html) : undefined,
			markers: markers.filter((m) => normalizeBody(html).includes(m)),
			warm: body.php?.warmInterpreter,
			baked: body.boot?.baked
		});
		return html;
	};
	await render('first');
	const done = json(
		await get(
			`/hostphp?${q}&b64=${encodeURIComponent(Buffer.from(edits[edit]!).toString('base64'))}`
		)
	);
	steps.push({ step: 'edit', note: done.out, context: done.context, baked: done.boot?.baked });
	await render('warm after edit');
	const dropped = json(await get(`/hostdrop?${q}`));
	steps.push({ step: 'drop', context: dropped.context });
	await render('cold after edit');
	return steps;
}

if (import.meta.main) {
	const [controlBase, bakedBase, seed] = process.argv.slice(2);
	if (!controlBase || !bakedBase || !seed)
		throw new Error('usage: stale.ts <control url> <baked url> <key=..&salt=..>');
	const out: Record<string, Record<string, StaleStep[]>> = {};
	for (const edit of (process.env.HOSTBOOT_EDITS ?? Object.keys(edits).join(',')).split(',')) {
		out[edit] = {
			control: await runCase(
				controlBase,
				`stale-${edit}-${process.env.HOSTBOOT_STALE_SUFFIX ?? 'x'}`,
				edit,
				seed
			),
			baked: await runCase(
				bakedBase,
				`stale-${edit}-${process.env.HOSTBOOT_STALE_SUFFIX ?? 'x'}`,
				edit,
				seed
			)
		};
	}
	console.log(JSON.stringify(out, null, 1));
}
