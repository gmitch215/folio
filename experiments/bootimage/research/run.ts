import binaryen from 'binaryen';
import { heapStore, openContext, stubImports } from 'folio:boot-context';
import assert from 'node:assert/strict';
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { digest } from '../../../scripts/research/environment.ts';
import {
	applyImage,
	bakeModule,
	captureImage,
	decodeImage,
	encodeImage
} from '../../../src/bake.ts';
import { imageDecision, normalizeHtml } from './policy.ts';

const root = process.env.FOLIO_BOOTIMAGE_ROOT;
assert.ok(root, 'set FOLIO_BOOTIMAGE_ROOT');
const [mode, output, name = 'base', arm = 'plain', round = '0'] = process.argv.slice(2);
assert.ok(output, 'usage: run.mjs prepare|case OUTPUT [CASE] [plain|guarded|unguarded] [ROUND]');
const work = join(root, 'state');
mkdirSync(work, { recursive: true });
const moduleBytes = new Uint8Array(
	readFileSync(join(root, 'build/bootimage/interp/php8.5.tuned.wasm'))
);
const moduleSha256 = digest(moduleBytes);
const emit = (row: Record<string, unknown>) =>
	appendFileSync(output, JSON.stringify({ ...row, moduleSha256 }) + '\n');
const snippets: Record<string, string> = {
	base: '',
	rename: "Drupal::configFactory()->getEditable('system.site')->set('name', 'Research Site')->save();",
	mail: "Drupal::configFactory()->getEditable('system.site')->set('mail', 'research@example.invalid')->save();",
	timezone:
		"Drupal::configFactory()->getEditable('system.date')->set('timezone.default', 'America/New_York')->save();",
	theme: "Drupal::configFactory()->getEditable('system.theme.global')->set('features.favicon', FALSE)->save();",
	color: "Drupal::configFactory()->getEditable('olivero.settings')->set('base_primary_color', '#ff2200')->save();",
	module: "$GLOBALS['__pw_kernel']->loadLegacyIncludes(); Drupal::moduleHandler()->loadAll(); $stack = Drupal::service('request_stack'); if ($stack->getCurrentRequest() === null) $stack->push(Request::create('/', 'GET')); Drupal::service('module_installer')->install(['ban']);",
	maintenance: "Drupal::state()->set('system.maintenance_mode', TRUE);",
	cache: "Drupal::service('cache_tags.invalidator')->invalidateTags(['config:system.site']);",
	alias: "Drupal\\path_alias\\Entity\\PathAlias::create(['path' => '/user/login', 'alias' => '/research-login', 'langcode' => 'und'])->save();",
	content:
		"Drupal\\node\\Entity\\Node::create(['type'=>'page','title'=>'Research Page','status'=>1,'promote'=>1,'uid'=>0,'body'=>['value'=>'Research body','format'=>'plain_text']])->save();",
	key: "Drupal::state()->set('system.private_key', 'folio-research-key-value');",
	salt: ''
};
const configDigest = (db: any) =>
	digest(
		JSON.stringify(
			db.prepare('SELECT name, data FROM config ORDER BY name').all(),
			(_key, value) =>
				value instanceof Uint8Array
					? Buffer.from(value).toString('base64')
					: typeof value === 'bigint'
						? String(value)
						: value
		)
	);
const modulesDigest = (db: any) =>
	digest(
		JSON.stringify(
			db.prepare("SELECT name, data FROM config WHERE name='core.extension'").all(),
			(_key, value) =>
				value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value
		)
	);
const globals = (instance: WebAssembly.Instance, entries: string[]) =>
	Object.fromEntries(
		entries.map((entry) => [
			Number(entry.split('_').at(-1)),
			(instance.exports[entry] as WebAssembly.Global).value
		])
	);
async function render(ctx: any, route = '/') {
	ctx.drupal.resetSql();
	const cpu = process.cpuUsage(),
		start = performance.now();
	const raw = await ctx.run(ctx.drupal.renderCode(route)),
		ms = performance.now() - start;
	const used = process.cpuUsage(cpu),
		page = JSON.parse(raw.slice(raw.indexOf('{')));
	assert.ok(typeof page.html === 'string', 'render returned no HTML');
	if (process.env.FOLIO_RESEARCH_HTML_DIR) {
		mkdirSync(process.env.FOLIO_RESEARCH_HTML_DIR, { recursive: true });
		writeFileSync(
			join(
				process.env.FOLIO_RESEARCH_HTML_DIR,
				`${name}-${arm}-${round}-${ctx.researchRenderSequence ?? 0}.html`
			),
			page.html
		);
		ctx.researchRenderSequence = (ctx.researchRenderSequence ?? 0) + 1;
	}
	const { normalized, formBuildIds } = normalizeHtml(page.html);
	return {
		sha256: digest(normalized),
		formBuildIds,
		status: page.status,
		bytes: page.bytes,
		ms,
		cpuMs: (used.user + used.system) / 1000
	};
}

if (mode === 'prepare' || mode === 'configure') {
	if (mode === 'prepare') {
		const generationStart = performance.now(),
			generationCpu = process.cpuUsage();
		const mod = binaryen.readBinary(moduleBytes),
			entries: string[] = [];
		for (let index = 0; index < mod.getNumGlobals(); index++) {
			const info = binaryen.getGlobalInfo(mod.getGlobalByIndex(index));
			if (!info.mutable) continue;
			const name = `research_global_${index}`;
			mod.addGlobalExport(info.name, name);
			entries.push(name);
		}
		const probe = mod.emitBinary();
		mod.dispose();
		writeFileSync(join(work, 'probe.wasm'), probe);
		const trace: any[] = [],
			ctx = await openContext(new WebAssembly.Module(probe as BufferSource), {
				traceAsm: trace
			});
		await ctx.render('/');
		const heap = await heapStore();
		const state = {
			asm: trace.filter((row) => row.sig === ''),
			streams: heap.captureStreams(ctx.binary.FS),
			...heap.captureHandles(ctx.binary.targets, ctx.binary),
			sealed: typeof ctx.binary.__cfwSeal === 'function'
		};
		const freshMemory = new WebAssembly.Memory({ initial: 1024, maximum: 65536 });
		const fresh = new WebAssembly.Instance(
			new WebAssembly.Module(probe as BufferSource),
			stubImports(new WebAssembly.Module(probe as BufferSource), freshMemory)
		);
		const before = globals(fresh, entries),
			after = globals(ctx.instance, entries);
		const image = captureImage(ctx.memory, freshMemory, {
			module: moduleSha256,
			context: configDigest(ctx.drupal.database()),
			globals: { booted: after, fresh: before }
		});
		const began = performance.now(),
			baked = await bakeModule(moduleBytes, image),
			bakeMs = performance.now() - began;
		writeFileSync(join(work, 'image.wasm'), baked);
		writeFileSync(join(work, 'image.bin'), encodeImage(image));
		writeFileSync(
			join(work, 'meta.json'),
			JSON.stringify({
				...state,
				context: image.context,
				modules: modulesDigest(ctx.drupal.database()),
				pages: image.byteLength / 65536,
				entries,
				globals: after
			})
		);
		emit({
			kind: 'image',
			sourceBytes: moduleBytes.length,
			bakedBytes: baked.length,
			bakedGzipBytes: gzipSync(baked).length,
			imageBytes: encodeImage(image).length,
			pages: image.pages.length,
			bakeMs,
			context: image.context,
			probeSha256: digest(probe)
		});
		await backup(ctx.drupal.database(), join(work, 'base.sqlite'));
		ctx.drupal.close();
		const generationUsed = process.cpuUsage(generationCpu);
		emit({
			kind: 'generation',
			wallMs: performance.now() - generationStart,
			cpuMs: (generationUsed.user + generationUsed.system) / 1000,
			scope: 'probe export construction through fresh boot, render, capture, bake, gzip, files and database backup; excludes process imports and harness bundling'
		});
	}
	for (const [name, snippet] of Object.entries(snippets)) {
		if (name === 'base') continue;
		if (
			process.env.FOLIO_BOOT_RESEARCH_CASES &&
			!process.env.FOLIO_BOOT_RESEARCH_CASES.split(',').includes(name)
		)
			continue;
		const path = join(work, `${name}.sqlite`);
		copyFileSync(join(work, 'base.sqlite'), path);
		process.env.FOLIO_RESEARCH_DB = path;
		const target = await openContext(new WebAssembly.Module(moduleBytes));
		if (snippet) {
			const changed = await target.run(
				'<?php use Drupal; use Throwable; use Symfony\\Component\\HttpFoundation\\Request; try { $GLOBALS["__pw_kernel"]->loadLegacyIncludes(); ' +
					snippet +
					" echo json_encode(['edited'=>true]); } catch (Throwable $error) { echo json_encode(['error'=>$error->getMessage()]); }"
			);
			assert.ok(
				changed.includes('"edited":true'),
				`configuration edit failed: ${name}: ${changed.slice(0, 1000)}`
			);
		}
		emit({
			kind: 'configuration',
			name,
			context: configDigest(target.drupal.database()),
			modules: modulesDigest(target.drupal.database())
		});
		target.drupal.close();
		delete process.env.FOLIO_RESEARCH_DB;
	}
} else if (mode === 'case') {
	assert.ok(
		name in snippets && ['plain', 'guarded', 'unguarded', 'reset', 'memory'].includes(arm)
	);
	const dbPath = join(work, `case-${name}-${arm}-${round}.sqlite`);
	assert.ok(!existsSync(dbPath), 'case already exists');
	copyFileSync(join(work, `${name}.sqlite`), dbPath);
	process.env.FOLIO_RESEARCH_DB = dbPath;
	const meta = JSON.parse(readFileSync(join(work, 'meta.json'), 'utf8'));
	// A fresh database reader computes eligibility before initialized PHP state is reused.
	const { DatabaseSync } = await import('node:sqlite');
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const context = configDigest(db),
		modules = modulesDigest(db);
	db.close();
	const { eligible, resetEligible, useImage } = imageDecision(
		arm,
		context,
		meta.context,
		modules,
		meta.modules
	);
	const bytes = useImage
		? new Uint8Array(readFileSync(join(work, arm === 'memory' ? 'probe.wasm' : 'image.wasm')))
		: moduleBytes;
	const cpu = process.cpuUsage(),
		began = performance.now(),
		compiled = performance.now(),
		module = new WebAssembly.Module(bytes);
	const compileMs = performance.now() - compiled;
	let copyMs = 0;
	const saved =
		arm === 'memory' && useImage
			? decodeImage(new Uint8Array(readFileSync(join(work, 'image.bin'))))
			: undefined;
	const options = useImage
		? {
				baked: true,
				pages: meta.pages,
				jsOnly: true,
				replay: meta,
				researchAfterInstantiate: saved
					? (instance: WebAssembly.Instance, memory: WebAssembly.Memory) => {
							const start = performance.now();
							applyImage(memory, saved, {
								module: moduleSha256,
								context: meta.context,
								memoryOnly: true
							});
							for (const entry of meta.entries)
								(instance.exports[entry] as WebAssembly.Global).value =
									meta.globals[Number(entry.split('_').at(-1))];
							copyMs = performance.now() - start;
						}
					: undefined
			}
		: {};
	const ctx = await openContext(module, {
		...options,
		researchSalt: name === 'salt' ? 'folio-site-specific-salt' : undefined
	});
	let renewal: unknown;
	if (useImage) {
		const code = readFileSync(join(root, 'renewal.php'), 'utf8').replace(
			'__CFW_RESET_CONFIG__',
			['reset', 'memory'].includes(arm) ? 'true' : 'false'
		);
		renewal = JSON.parse(await ctx.run(code));
	}
	const first = await render(ctx, name === 'alias' ? '/research-login' : '/');
	const wallMs = performance.now() - began,
		used = process.cpuUsage(cpu),
		warm = await render(ctx, name === 'alias' ? '/research-login' : '/');
	const securityRaw = await ctx.run(
		"<?php use Drupal; use Drupal\\Core\\Site\\Settings; use Throwable; try { echo json_encode(['keySha'=>hash('sha256', Drupal::service('private_key')->get()),'saltSha'=>hash('sha256', Settings::getHashSalt()),'random'=>[mt_rand(),mt_rand(),mt_rand()]]); } catch (Throwable $error) { echo json_encode(['error'=>$error->getMessage()]); }"
	);
	const security = JSON.parse(
		securityRaw.slice(securityRaw.indexOf('{'), securityRaw.lastIndexOf('}') + 1)
	);
	assert.ok(!security.error, `security probe failed: ${security.error}`);
	emit({
		kind: 'sample',
		name,
		arm,
		round: Number(round.split('-').at(-1)),
		eligible,
		resetEligible,
		useImage,
		context,
		modules,
		copyMs,
		renewal,
		compileMs,
		wallMs,
		cpuMs: (used.user + used.system) / 1000,
		first,
		warm,
		security,
		marks: ctx.marks,
		memoryBytes: ctx.memory.buffer.byteLength
	});
	ctx.drupal.close();
} else throw new Error('unknown research mode');
