import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	applyImage,
	bakeModule,
	captureImage,
	checkBaked,
	decodeImage,
	encodeImage,
	ImageMismatchError,
	type ApplyOptions,
	type MemoryImage
} from '../../src/bake.ts';
import {
	clusterSweep,
	compareSweeps,
	diffImages,
	judge,
	scanBytes,
	scanImage,
	sweepBytes,
	type Secret,
	type SweepFinding
} from '../analyze/bakesecrets.ts';
import { phpString, rekeyCode, variants } from './bake-rekey.ts';
import { resolveConsumer } from './consumer-root.ts';

const usage = `usage: node scripts/probe/bake-secrets.ts MODE OUTPUT.jsonl [ARGS]
  pin               copy the interpreter into build/bakesecrets/interp (refuses another digest)
  probe             build probe.wasm, the module with its mutable globals exported
  capture [TAG]     T1: two sentinel bakes and a control bake, baked modules, leak scans, image diffs
  keying            the module and context digest checks of applyImage on the sentinel image
  t2 N              T2: replay into a site with its own key and salt, per rekey variant, then validate
  t3 N              T3: first random values in N fresh replays, without and with the rekey step
  census N          the host calls a replay and a plain boot make before the first request, per phase, N processes
  sweep             a static scan of the baked heap for secret-shaped strings beyond the sentinels
  arms N            plain boot, baked replay, and baked replay with the rekey step, N processes each
FOLIO_CONSUMER names the consumer copy; FOLIO_MACHINE labels the rows`;

const PAGE = 65536;
const pinSha256 =
	process.env.FOLIO_PIN_WASM_SHA256 ??
	'95447d3dd001ccbdbb392a6f5f64210380712a76cf22b00487333277414ba6e4';
const pinGlueSha256 = process.env.FOLIO_PIN_GLUE_SHA256;
const root = process.env.FOLIO_BAKESECRETS_ROOT ?? new URL('../../', import.meta.url).pathname;
const here = new URL('.', import.meta.url);
const consumerEnv = process.env.FOLIO_CONSUMER;
const consumer = resolve(consumerEnv ?? '/nonexistent');
const work = join(root, 'build/bakesecrets');
const bundle = join(root, 'build/bake-secrets-child.mjs');
const pinned = join(work, 'interp');
const original = join(pinned, 'php8.5.tuned.wasm');
const glue = join(pinned, 'php8.5-worker.tuned.mjs');
const child = process.env.FOLIO_BAKESECRETS_CHILD === '1';
const bootimageWork = join(root, 'build/bootimage');

type Row = Record<string, any>;
const [mode, output, ...rest] = process.argv.slice(2);

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const sha16 = (data: string) => sha(data).slice(0, 16);
const digestOf = (path: string) => (existsSync(path) ? sha(readFileSync(path)) : undefined);
const interp = { wasmSha256: digestOf(original), glueSha256: digestOf(glue) };
const emit = (row: Row) => {
	if (!output) return;
	appendFileSync(output, JSON.stringify({ ...row, interp, load: loadavg() }) + '\n');
};
const path = (name: string) => join(work, name);
const readJson = (name: string) => JSON.parse(readFileSync(path(name), 'utf8'));
const writeJson = (name: string, value: unknown) =>
	writeFileSync(path(name), JSON.stringify(value));

// a base64url key of 55 bytes, the shape Drupal's Crypt::randomBytesBase64(55) gives (74 characters)
const randomSecret = () => randomBytes(55).toString('base64url');
// the salt the consumer harness hard-codes, and what the boot image probe's images were taken with
const legacySalt = 'folio-render-proof-fixed-salt';

/** what makes a replaying site's heap valid for the image, other than the module: glue, driver and database identity */
function contextDigest(generation?: string) {
	const manifest = JSON.parse(
		readFileSync(join(consumer, 'assets/drupal-sql/manifest.json'), 'utf8')
	);
	return sha(
		JSON.stringify({
			glue: interp.glueSha256,
			driver: sha(readFileSync(join(consumer, 'assets/driver.json'))),
			sql: generation ?? manifest.generation
		})
	);
}

// #region php

const RNG_PHP = `<?php echo json_encode([
	'mtRand' => mt_rand(),
	'uniqid' => uniqid(),
	'uniqidMore' => uniqid('', true),
	'randomInt' => (string) random_int(0, PHP_INT_MAX)
]);`;

const csrfSeed = 'folio-fixed-session-seed';
const csrfValue = 'folio-t2';

const csrfCode = (tokens: string[]) => `<?php
use Drupal\\Core\\Site\\Settings;
Drupal::service('session_manager.metadata_bag')->setCsrfTokenSeed(${phpString(csrfSeed)});
$generator = Drupal::csrfToken();
$valid = [];
foreach (json_decode(${phpString(JSON.stringify(tokens))}, true) as $token) {
	$valid[] = $generator->validate($token, ${phpString(csrfValue)});
}
echo json_encode([
	'token' => $generator->get(${phpString(csrfValue)}),
	'valid' => $valid,
	'keySha' => hash('sha256', Drupal::service('private_key')->get()),
	'saltSha' => hash('sha256', Settings::getHashSalt()),
	'sessionId' => session_id()
]);`;

const SESSION_PHP = `<?php
$session = Drupal::service('session');
echo json_encode([
	'mt' => [mt_rand(), mt_rand()],
	'sessionStatus' => session_status(),
	'sessionId' => session_id(),
	'apiStarted' => $session->isStarted(),
	'apiId' => $session->getId(),
	'csrfSeed' => Drupal::service('session_manager.metadata_bag')->getCsrfTokenSeed()
]);`;

const COOKIE_NAME_PHP = `<?php
use Symfony\\Component\\HttpFoundation\\Request;
echo json_encode(['name' => Drupal::service('session_configuration')
	->getOptions(Request::create('https://folio.invalid/'))['name']]);`;

const loadUserPhp = (uid: number) => `<?php
use Drupal\\user\\Entity\\User;
$user = User::load(${uid});
echo json_encode(['name' => $user->getAccountName(), 'mail' => $user->getEmail()]);`;

// #endregion

// #region orchestrator

function pinInterpreter() {
	mkdirSync(pinned, { recursive: true });
	const source = process.env.FOLIO_PIN_SOURCE ?? join(root, 'experiments/consumer/build/php');
	const rows = [
		['php.wasm', 'php8.5.tuned.wasm'],
		['glue.mjs', 'php8.5-worker.tuned.mjs']
	].map(([from, name]) => {
		const target = join(pinned, name!);
		writeFileSync(target, readFileSync(join(source, from!)));
		return { name, bytes: readFileSync(target).length, sha256: digestOf(target) };
	});
	if (rows[0]!.sha256 !== pinSha256)
		throw new Error(`the module ${rows[0]!.sha256} is not the pinned ${pinSha256}`);
	if (pinGlueSha256 && rows[1]!.sha256 !== pinGlueSha256)
		throw new Error(`the glue ${rows[1]!.sha256} is not the pinned ${pinGlueSha256}`);
	Object.assign(interp, { wasmSha256: digestOf(original), glueSha256: digestOf(glue) });
	emit({ kind: 'pin', source: basename(source), files: rows });
}

async function buildProbe() {
	const binaryen = (await import('binaryen')).default;
	const mod = binaryen.readBinary(readFileSync(original));
	const globals: { name: string; index: number; value: number }[] = [];
	for (let index = 0; index < mod.getNumGlobals(); index++) {
		const info = binaryen.getGlobalInfo(mod.getGlobalByIndex(index));
		if (!info.mutable || !info.init) continue;
		const init = binaryen.getExpressionInfo(info.init) as any;
		globals.push({ name: info.name, index, value: Number(init.value) });
	}
	globals.forEach((entry, i) => mod.addGlobalExport(entry.name, `bi_global${i}`));
	writeFileSync(path('probe.wasm'), mod.emitBinary());
	writeJson('probe.json', globals);
	mod.dispose();
	emit({ kind: 'probe', globals });
}

async function buildChild() {
	mkdirSync(join(bundle, '..'), { recursive: true });
	const { build } = await import('esbuild');
	await build({
		entryPoints: [new URL('./bake-secrets.ts', here).pathname],
		outfile: bundle,
		bundle: true,
		platform: 'node',
		format: 'esm',
		logLevel: 'error',
		external: ['node:*', 'esbuild', 'binaryen'],
		plugins: [
			{
				name: 'consumer',
				setup(builder) {
					builder.onResolve({ filter: /^consumer:/ }, (args) => ({
						path: resolveConsumer(consumer, args.path)
					}));
				}
			}
		]
	});
}

function runChild(args: string[]) {
	const done = spawnSync(process.execPath, [bundle, ...args], {
		stdio: 'inherit',
		env: {
			...process.env,
			FOLIO_BAKESECRETS_CHILD: '1',
			FOLIO_BAKESECRETS_ROOT: root,
			FOLIO_CONSUMER: consumer
		}
	});
	if (done.status !== 0) throw new Error(`child ${args.join(' ')} exited ${done.status}`);
}

const originalBytes = () => new Uint8Array(readFileSync(original));
const loadImage = (tag: string) => decodeImage(new Uint8Array(readFileSync(path(`${tag}.img`))));

type Role = 'sentinel' | 'control' | 'legacy';

/** what each needle recorded by the capture child should do in an image of that role */
const expectations: Record<'sentinel' | 'control', Record<string, Secret['expect']>> = {
	sentinel: {
		userName: 'absent',
		userMail: 'absent',
		userPass: 'absent',
		sessionSid: 'absent',
		bakeSessionId: 'absent',
		bakeCsrfSeed: 'info',
		permissionsHash: 'info',
		viewDomId: 'info',
		fileCachePrefix: 'info',
		cronKey: 'info',
		packSalt: 'info'
	},
	control: {
		userName: 'present',
		userMail: 'present',
		userPass: 'info',
		sessionSid: 'present',
		bakeSessionId: 'info',
		bakeCsrfSeed: 'info',
		permissionsHash: 'info',
		viewDomId: 'info',
		fileCachePrefix: 'info',
		cronKey: 'info',
		packSalt: 'info'
	}
};

const secret = (name: string, value: string, expect: Secret['expect']): Secret => ({
	name,
	bytes: new TextEncoder().encode(value),
	expect
});

/** the secrets one image is scanned for, with what each scan should find */
function secretsFor(tag: string, role: 'sentinel' | 'control', tags: string[]) {
	const own = readJson(`${tag}.secrets.json`);
	const real = readJson('real.secrets.json');
	const meta = readJson(`${tag}.meta.json`);
	const list: Secret[] =
		role === 'sentinel'
			? [
					secret('bakeKey', own.key, 'present'),
					secret('bakeSalt', own.salt, 'present'),
					secret('siteKey', real.key, 'absent'),
					secret('siteSalt', real.salt, 'absent')
				]
			: [secret('siteKey', own.key, 'present'), secret('siteSalt', own.salt, 'present')];
	for (const [name, expect] of Object.entries(expectations[role]))
		if (meta.needles[name]) list.push(secret(name, meta.needles[name], expect));
	for (const other of tags.filter((t) => t !== tag && t.startsWith('sentinel')))
		list.push(secret(`${other}Key`, readJson(`${other}.secrets.json`).key, 'absent'));
	return list;
}

async function captureMode() {
	const tags: [string, Role][] = [
		['sentinel-a', 'sentinel'],
		['sentinel-b', 'sentinel'],
		['control', 'control'],
		['legacy', 'legacy']
	];
	const only = rest[0];
	if (!only) writeJson('real.secrets.json', { key: randomSecret(), salt: randomSecret() });
	const real = readJson('real.secrets.json');
	for (const [tag, role] of tags)
		if (!only || tag === only)
			writeJson(
				`${tag}.secrets.json`,
				role === 'sentinel'
					? { key: randomSecret(), salt: randomSecret() }
					: role === 'legacy'
						? { salt: legacySalt }
						: real
			);
	await buildChild();
	for (const [tag, role] of tags) {
		if (only && tag !== only) continue;
		runChild(['capture', output!, tag, role]);
		if (role === 'legacy') continue;
		const image = loadImage(tag);
		const t0 = performance.now();
		const baked = await bakeModule(originalBytes(), image);
		const bakeMs = performance.now() - t0;
		writeFileSync(path(`${tag}.wasm`), baked);
		const check = checkBaked(baked, image);
		emit({
			kind: 'bake',
			tag,
			role,
			bakeMs,
			bakedSha256: sha(baked),
			moduleBytes: baked.length,
			deltaPages: image.pages.length,
			valid: WebAssembly.validate(baked as BufferSource),
			checkEqual: check.equal,
			globalsInImage: Object.keys(image.globals ?? {}).length,
			tableSlotsInImage: image.tableSlots?.length ?? 0
		});
		const secrets = secretsFor(
			tag,
			role,
			tags.map(([name]) => name)
		);
		for (const target of ['image', 'module'] as const) {
			const t = performance.now();
			const bytes = target === 'image' ? image.data.length : baked.length;
			const hits = target === 'image' ? scanImage(image, secrets) : scanBytes(baked, secrets);
			emit({
				kind: 'scan',
				tag,
				role,
				target,
				targetBytes: bytes,
				scanMs: performance.now() - t,
				secrets: secrets.map((s) => ({
					name: s.name,
					length: s.bytes.length,
					sha256: sha16(Buffer.from(s.bytes).toString('latin1')),
					expect: s.expect
				})),
				results: judge(hits, secrets)
			});
		}
	}
	if (!only) diffRows();
}

/** pages and bytes that differ from the boot image probe's render image, and between the runs here */
function diffRows() {
	const earlierMeta = JSON.parse(readFileSync(join(bootimageWork, 'meta.json'), 'utf8'));
	const earlier: MemoryImage = {
		byteLength: earlierMeta.images.render.memoryBytes,
		pages: JSON.parse(readFileSync(join(bootimageWork, 'render.delta.pages.json'), 'utf8')),
		data: new Uint8Array(readFileSync(join(bootimageWork, 'render.delta.bin')))
	};
	const a = loadImage('sentinel-a');
	const b = loadImage('sentinel-b');
	const control = loadImage('control');
	const pairs: [string, string, MemoryImage, MemoryImage][] = [
		['bootimage', 'sentinel-a', earlier, a],
		['bootimage', 'sentinel-b', earlier, b],
		['bootimage', 'legacy', earlier, loadImage('legacy')],
		['legacy', 'sentinel-a', loadImage('legacy'), a],
		['sentinel-a', 'sentinel-b', a, b],
		['sentinel-a', 'control', a, control]
	];
	for (const [left, right, x, y] of pairs)
		emit({
			kind: 'diff',
			left,
			right,
			bootimageInterpSha256: earlierMeta.interpSha256,
			...diffImages(x, y)
		});
}

async function keyingMode() {
	const image = loadImage('sentinel-a');
	const context = contextDigest();
	const wrongContext = contextDigest('0000000000000000');
	const wrongModule = '1'.repeat(64);
	// the sentinel image records changed globals, which applyImage refuses unless told to copy
	// memory only; the digest cases pass that knowingly so each one reaches its own check
	const only = { memoryOnly: true };
	const cases: [string, ApplyOptions][] = [
		['match', { module: interp.wasmSha256, context, ...only }],
		['module only', { module: interp.wasmSha256, ...only }],
		['no expectation', { ...only }],
		['wrong module', { module: wrongModule, context, ...only }],
		['wrong context', { module: interp.wasmSha256, context: wrongContext, ...only }],
		['changed globals, default', { module: interp.wasmSha256, context }]
	];
	for (const [name, expect] of cases) {
		const memory = new WebAssembly.Memory({ initial: image.byteLength / PAGE });
		let refused: string | undefined;
		try {
			applyImage(memory, image, expect);
		} catch (error) {
			refused = error instanceof ImageMismatchError ? error.code : String(error);
		}
		const bytes = new Uint8Array(memory.buffer);
		emit({
			kind: 'keying',
			case: name,
			refused: refused ?? null,
			memoryUntouched: refused ? bytes.every((value) => value === 0) : undefined,
			imageModule: image.module,
			imageContext: image.context,
			expectedContext: expect.context
		});
	}
	const encoded = decodeImage(encodeImage(image));
	emit({
		kind: 'keying',
		case: 'encoded round trip',
		refused: null,
		imageModule: encoded.module,
		imageContext: encoded.context,
		expectedContext: context,
		contextEqual: encoded.context === context
	});
}

const readRows = (file: string): Row[] =>
	existsSync(file)
		? readFileSync(file, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];

async function t2Mode(count: number) {
	await buildChild();
	const t2: [string, string][] = [
		...Object.keys(variants).map((variant) => ['apply', variant] as [string, string]),
		['baked', 'full']
	];
	for (const [via, variant] of t2)
		for (let i = 0; i < count; i++)
			runChild(['replay', output!, 'T2', variant, 'sentinel-a', String(i), via]);
	const tokens = readRows(output!)
		.filter((row) => row.kind === 'replay' && row.test === 'T2')
		.flatMap((row) =>
			['pre', 'post'].map((phase) => ({
				variant: row.variant,
				via: row.via,
				phase,
				token: row[phase].token
			}))
		);
	writeJson('tokens.json', tokens);
	for (const config of ['real', 'bake'])
		for (let i = 0; i < count; i++)
			runChild(['reference', output!, config, 'sentinel-a', String(i)]);
}

async function t3Mode(count: number) {
	await buildChild();
	for (const variant of ['none', 'full'])
		for (let i = 0; i < count; i++)
			runChild(['replay', output!, 'T3', variant, 'sentinel-a', String(i), 'apply']);
}

async function armsMode(count: number) {
	await buildChild();
	for (let i = 0; i < count; i++)
		for (const arm of ['plain', 'baked', 'rekeyed']) runChild(['arm', output!, arm, String(i)]);
}

/**
 * a static sweep of two independent sentinel images for secret-shaped strings. A string both images
 * hold cannot be a per-bake secret; a string only one holds is random or derived from the bake's
 * key, salt or request, and is listed with the text before it so each can be named.
 */
function sweepMode() {
	const tags = ['sentinel-a', 'sentinel-b'];
	const sweeps = tags.map((tag) => {
		const image = loadImage(tag);
		const secrets = readJson(`${tag}.secrets.json`);
		const needles = readJson(`${tag}.meta.json`).needles as Record<string, string>;
		const known = new Map<string, string>(
			Object.entries({ bakeKey: secrets.key, bakeSalt: secrets.salt, ...needles }).map(
				([name, value]) => [sha(value as string).slice(0, 16), name]
			)
		);
		const t = performance.now();
		const findings = sweepBytes(image.data);
		emit({
			kind: 'sweep',
			tag,
			bytes: image.data.length,
			sweepMs: performance.now() - t,
			distinct: findings.length,
			occurrences: findings.reduce((n, finding) => n + finding.count, 0),
			byClass: Object.fromEntries(
				['hex32', 'hex40', 'hex64', 'base64url', 'base64'].map((name) => {
					const list = findings.filter((finding) => finding.class === name);
					return [
						name,
						{
							distinct: list.length,
							occurrences: list.reduce((n, f) => n + f.count, 0)
						}
					];
				})
			),
			known: findings
				.filter((finding) => known.has(finding.sha16))
				.map((finding) => ({
					name: known.get(finding.sha16),
					class: finding.class,
					count: finding.count
				}))
		});
		return { tag, findings, known };
	});
	const [a, b] = sweeps as [(typeof sweeps)[number], (typeof sweeps)[number]];
	const diff = compareSweeps(a.findings, b.findings);
	// a random string Drupal puts in the page and replaces before it answers
	const placeholder = /placeholder token="$|holder token="$/;
	const show = (finding: SweepFinding, known: Map<string, string>) => ({
		...finding,
		known:
			known.get(finding.sha16) ??
			(placeholder.test(finding.before) ? 'placeholderToken' : undefined)
	});
	emit({
		kind: 'sweepCompare',
		left: a.tag,
		right: b.tag,
		shared: diff.shared.length,
		onlyLeft: diff.onlyA.length,
		onlyRight: diff.onlyB.length,
		sharedOccurrences: diff.shared.reduce((n, finding) => n + finding.count, 0),
		onlyLeftOccurrences: diff.onlyA.reduce((n, finding) => n + finding.count, 0),
		sharedClusters: clusterSweep(diff.shared).slice(0, 40),
		onlyLeftClusters: clusterSweep(diff.onlyA).slice(0, 60)
	});
	for (const finding of diff.onlyA) emit({ kind: 'sweepOnlyLeft', ...show(finding, a.known) });
}

async function censusMode(count: number) {
	await buildChild();
	for (let i = 0; i < count; i++)
		for (const via of ['plain', 'baked', 'apply'])
			runChild(['census', output!, via, String(i)]);
}

if (!child) {
	if (!mode) throw new Error(usage);
	if (!consumerEnv) throw new Error('set FOLIO_CONSUMER to the consumer copy');
	if (mode !== 'pin' && !existsSync(original)) throw new Error('run the pin mode first');
	mkdirSync(work, { recursive: true });
	if (mode === 'pin') pinInterpreter();
	emit({
		kind: 'environment',
		machine: process.env.FOLIO_MACHINE ?? 'unlabeled',
		node: process.version,
		cpu: cpus()[0]!.model,
		hardwareThreads: cpus().length,
		mode
	});
	if (mode === 'probe') await buildProbe();
	else if (mode === 'capture') await captureMode();
	else if (mode === 'keying') await keyingMode();
	else if (mode === 't2') await t2Mode(Number(rest[0] ?? 3));
	else if (mode === 't3') await t3Mode(Number(rest[0] ?? 10));
	else if (mode === 'census') await censusMode(Number(rest[0] ?? 3));
	else if (mode === 'sweep') sweepMode();
	else if (mode === 'arms') await armsMode(Number(rest[0] ?? 10));
	else if (mode !== 'pin') throw new Error(usage);
	const after = { wasmSha256: digestOf(original), glueSha256: digestOf(glue) };
	const same = after.wasmSha256 === interp.wasmSha256 && after.glueSha256 === interp.glueSha256;
	emit({ kind: 'interpCheck', start: interp, end: after, same });
	if (!same) throw new Error('the pinned interpreter changed during the run');
	process.exit(0);
}

// #endregion

// #region child

const g = globalThis as any;
g.self ??= g;
g.location ??= new URL('https://folio.invalid/worker.mjs');

const consumerUrl = (file: string) => pathToFileURL(join(consumer, file)).href;
const now = () => performance.now();
const view = (memory: WebAssembly.Memory) => new Uint8Array(memory.buffer);

interface Replay {
	stackPointer?: number;
	sealed?: boolean;
	asm: Row[];
	streams: any[];
	handles: any[];
}

interface OpenOptions {
	/** the module is baked or an image is applied: runtime init is skipped, the JS side is replayed */
	baked?: boolean;
	pages?: number;
	replay?: Replay;
	/** copied over the fresh instance right after instantiation, with its keying checks */
	apply?: { image: MemoryImage; expect: ApplyOptions };
	traceAsm?: Row[];
	/** the private key and hash salt this site holds, seeded before the first read; no key, no row */
	key?: string;
	salt: string;
	/** extra rows for the private database before the context opens */
	seed?: (db: any) => void;
	/** counts every call the module makes into the host, by phase */
	census?: Census;
}

/** wasm to host calls by phase and import; harness calls are the ones this script makes itself */
interface Census {
	phase: string;
	harness: boolean;
	calls: Record<string, Record<string, number>>;
	/** the cfw functions as they were before the counting wrappers went on */
	originals: Record<string, unknown>;
}

const bump = (census: Census, name: string) => {
	const phase = (census.calls[census.phase] ??= {});
	const key = census.harness ? `harness:${name}` : name;
	phase[key] = (phase[key] ?? 0) + 1;
};

/** replaces every function import with a counting wrapper; call before the module is instantiated */
function countImports(given: any, module: WebAssembly.Module, census: Census) {
	for (const item of WebAssembly.Module.imports(module)) {
		const table = given[item.module];
		const original = table?.[item.name];
		if (item.kind !== 'function' || typeof original !== 'function') continue;
		table[item.name] = (...args: unknown[]) => {
			bump(census, `${item.module}.${item.name}`);
			return original(...args);
		};
	}
}

/** wraps each Module.cfw* host function; the glue seals the wrapper, so PHP calls count here */
function countCfw(binary: any, census: Census) {
	for (const name of Object.keys(binary))
		if (/^cfw[A-Za-z0-9]*$/.test(name) && typeof binary[name] === 'function') {
			const original = binary[name];
			census.originals[name] = original;
			binary[name] = (...args: unknown[]) => {
				bump(census, `Module.${name}`);
				return original(...args);
			};
		}
}

interface Context {
	binary: any;
	run(code: string): Promise<string>;
	memory: WebAssembly.Memory;
	instance: WebAssembly.Instance;
	imports: WebAssembly.Imports;
	marks: Record<string, any>;
	drupal: any;
}

let heapStoreModule: any;
const heapStore = async () => (heapStoreModule ??= await import('consumer:src/db/heap-store.ts'));
function replayState(binary: any, replay: Replay) {
	const h = heapStoreModule;
	const streams = h.replayStreams(binary.FS, replay.streams);
	const handles = h.replayHandles(binary.targets, binary, replay.handles);
	return {
		streamsReplayed: streams.replayed.length,
		streamsFailed: streams.failed,
		handlesReplayed: handles.replayed.length,
		handlesFailed: handles.failed
	};
}

function traceAsm(
	given: WebAssembly.Imports,
	memory: WebAssembly.Memory,
	out: Row[],
	stage: () => string
) {
	const env = given.env as Record<string, (...args: number[]) => number>;
	for (const key of Object.keys(env).filter((name) => name.includes('asm_const'))) {
		const wrapped = env[key]!;
		env[key] = (code, sigPtr, argbuf) => {
			if (stage()) {
				const bytes = new Uint8Array(memory.buffer);
				const f64 = new Float64Array(memory.buffer);
				const i32 = new Int32Array(memory.buffer);
				let sig = '';
				const args: number[] = [];
				let buf = argbuf >>> 0;
				for (let at = sigPtr >>> 0, ch; (ch = bytes[at++]);) {
					sig += String.fromCharCode(ch);
					const wide = ch !== 105 && ch !== 112;
					if (wide && buf % 8) buf += 4;
					args.push(ch === 112 || ch === 105 ? i32[buf >>> 2]! : f64[buf >>> 3]!);
					buf += wide ? 8 : 4;
				}
				out.push({ key, stage: stage(), code: code >>> 0, sig, args });
			}
			return wrapped(code, sigPtr, argbuf);
		};
	}
}

const serialized = (value: string) => Buffer.from(`s:${value.length}:"${value}";`);

async function openContext(module: WebAssembly.Module, options: OpenOptions): Promise<Context> {
	const marks: Record<string, any> = {};
	await heapStore();
	const t0 = now();
	const drupal: any = await import('./php-context-drupal.ts');
	await drupal.prepare(consumer);
	if (options.key)
		drupal
			.database()
			.prepare(
				"INSERT OR REPLACE INTO key_value (collection, name, value) VALUES ('state', ?, ?)"
			)
			.run('system.private_key', serialized(options.key));
	options.seed?.(drupal.database());
	marks.seedMs = now() - t0;
	const { default: Factory } = await import(pathToFileURL(glue).href);
	const { PhpBase } = await import(consumerUrl('node_modules/php-wasm/PhpBase.mjs'));
	let memory!: WebAssembly.Memory;
	let instance!: WebAssembly.Instance;
	let imports!: WebAssembly.Imports;
	let stage = '';
	const printed: string[] = [];
	const t2 = now();
	const php = new PhpBase(
		Promise.resolve({ default: Factory }) as any,
		{
			ini: [
				'opcache.enable=0',
				'opcache.enable_cli=0',
				'memory_limit=96M',
				drupal.disabled()
			].join('\n'),
			printErr: () => {},
			instantiateWasm(given: WebAssembly.Imports, receive: (a: any, b: any) => void) {
				(async () => {
					await Promise.resolve();
					memory = new WebAssembly.Memory(
						options.pages ? { initial: options.pages, maximum: 65536 } : drupal.memory()
					);
					(given.env as any).memory = memory;
					imports = given;
					if (options.replay?.stackPointer !== undefined)
						(given.env as any).__stack_pointer.value = options.replay.stackPointer;
					if (options.traceAsm) traceAsm(given, memory, options.traceAsm, () => stage);
					if (options.census) countImports(given, module, options.census);
					const ti = now();
					instance = new WebAssembly.Instance(module, given);
					marks.instantiateMs = now() - ti;
					if (options.apply) {
						const ta = now();
						applyImage(memory, options.apply.image, options.apply.expect);
						marks.applyMs = now() - ta;
					}
					const exports: Record<string, any> = { ...instance.exports };
					for (const name of ['__wasm_call_ctors', 'pib_storage_init', 'pib_init']) {
						const wrapped = instance.exports[name] as (...args: any[]) => any;
						exports[name] = (...args: any[]) => {
							if (options.baked) {
								if (options.census) options.census.harness = true;
								for (const call of options.replay?.asm ?? [])
									if (call.stage === name)
										(given.env as any)[call.key](call.code, 0, 0);
								if (options.census) options.census.harness = false;
								return 0;
							}
							stage = name;
							try {
								return wrapped(...args);
							} finally {
								stage = '';
							}
						};
					}
					receive({ exports }, module);
				})().catch((error) => {
					console.error(error);
					process.exit(1);
				});
				return {};
			}
		} as any
	);
	php.addEventListener('output', (event: any) => printed.push(...[].concat(event.detail ?? [])));
	const binary = await php.binary;
	marks.factoryMs = now() - t2;
	const run = async (code: string) => {
		printed.length = 0;
		await php._run(code);
		return printed.join('');
	};
	const tb = now();
	await drupal.boot(binary, run, { jsOnly: options.baked, salt: options.salt });
	marks.bootMs = now() - tb;
	if (options.census) {
		countCfw(binary, options.census);
		options.census.phase = 'replay';
	}
	if (options.replay) {
		const t = now();
		marks.replay = replayState(binary, options.replay);
		marks.replayMs = now() - t;
	}
	marks.openMs = now() - t0;
	return { binary, run, memory, instance, imports, marks, drupal };
}

const parse = (raw: string) => JSON.parse(raw.slice(raw.indexOf('{')));

/** a render with the raw html kept, which the harness's own render() drops */
async function render(ctx: Context, route = '/', request: Row = {}) {
	ctx.drupal.resetSql();
	const s = now();
	const raw = await ctx.run(ctx.drupal.renderCode(route, undefined, request));
	const ms = now() - s;
	const summary = ctx.drupal.summarize(raw);
	const page = parse(raw);
	return {
		ms,
		sha256: summary.sha256 as string,
		rawSha256: sha(page.html),
		status: page.status as number,
		bytes: page.bytes as number,
		permissionsHash: /"permissionsHash":"([0-9a-f]{64})"/.exec(page.html)?.[1],
		viewDomId: /js-view-dom-id-([0-9a-f]{64})/.exec(page.html)?.[1]
	};
}

const original8 = () => new WebAssembly.Module(readFileSync(original));

const exportedGlobals = (instance: WebAssembly.Instance, probe: Row[]) =>
	Object.fromEntries(
		probe.map((entry, i) => [
			entry.index,
			Number((instance.exports[`bi_global${i}`] as WebAssembly.Global).value)
		])
	);

const tableOf = (instance: WebAssembly.Instance) =>
	instance.exports.__indirect_function_table as WebAssembly.Table;

// same module, so equal function indexes are the same function; captureImage compares by identity
const preBootTable = (booted: WebAssembly.Table, fresh: WebAssembly.Table) => {
	const copy = new WebAssembly.Table({ element: 'anyfunc', initial: fresh.length });
	for (let slot = 0; slot < fresh.length; slot++) {
		const then = fresh.get(slot);
		const now = slot < booted.length ? booted.get(slot) : null;
		copy.set(slot, then && now && then.name === now.name ? now : then);
	}
	return copy;
};

/** the image a sentinel or control bake takes, plus what a replay of it needs from the JS side */
async function capture(tag: string, role: Role) {
	const secrets = JSON.parse(readFileSync(path(`${tag}.secrets.json`), 'utf8'));
	const probe: Row[] = JSON.parse(readFileSync(path('probe.json'), 'utf8'));
	const module = new WebAssembly.Module(readFileSync(path('probe.wasm')));
	const tag6 = randomBytes(6).toString('hex');
	const user = {
		uid: 100,
		name: `folio_${tag6}`,
		mail: `folio-${tag6}@example.invalid`,
		pass: randomBytes(48).toString('base64url'),
		sid: randomBytes(32).toString('base64url')
	};
	const seedUsers = (db: any) => {
		db.prepare("INSERT INTO users (uid, uuid, langcode) VALUES (?, ?, 'en')").run(
			user.uid,
			crypto.randomUUID()
		);
		db.prepare(
			"INSERT INTO users_field_data (uid, langcode, preferred_langcode, name, pass, mail, timezone, status, created, changed, access, login, init, default_langcode) VALUES (?, 'en', 'en', ?, ?, ?, 'UTC', 1, 1700000000, 1700000000, 1700000000, 1700000000, ?, 1)"
		).run(user.uid, user.name, user.pass, user.mail, user.mail);
		db.prepare(
			'INSERT INTO sessions (uid, sid, hostname, timestamp, session) VALUES (?, ?, ?, ?, ?)'
		).run(
			user.uid,
			createHash('sha256').update(user.sid).digest('base64url'),
			'127.0.0.1',
			1700000000,
			Buffer.alloc(0)
		);
	};
	const pibAsm: Row[] = [];
	const ctx = await openContext(module, {
		traceAsm: pibAsm,
		key: secrets.key,
		salt: secrets.salt,
		seed: role === 'legacy' ? undefined : seedUsers
	});
	const heap = await heapStore();
	const fresh = new WebAssembly.Memory(ctx.drupal.memory());
	const freshInstance = new WebAssembly.Instance(module, stubImports(module, fresh));
	let request: Row = {};
	let cookieName: string | undefined;
	if (role === 'control') {
		cookieName = parse(await ctx.run(COOKIE_NAME_PHP)).name;
		request = { cookie: `${cookieName}=${user.sid}` };
	}
	const first = await render(ctx, '/', request);
	let loaded: Row | undefined;
	if (role === 'control') loaded = parse(await ctx.run(loadUserPhp(user.uid)));
	const bootedGlobals = exportedGlobals(ctx.instance, probe);
	const image = captureImage(ctx.memory, fresh, {
		module: interp.wasmSha256,
		context: contextDigest(),
		globals: { booted: bootedGlobals, fresh: exportedGlobals(freshInstance, probe) },
		table: {
			booted: tableOf(ctx.instance),
			fresh: preBootTable(tableOf(ctx.instance), tableOf(freshInstance))
		}
	});
	const stackPointer = (ctx.imports.env as any).__stack_pointer
		? Number((ctx.imports.env as any).__stack_pointer.value)
		: undefined;
	const js = {
		stackPointer,
		sealed: typeof ctx.binary.__cfwSeal === 'function',
		streams: heap.captureStreams(ctx.binary.FS),
		...heap.captureHandles(ctx.binary.targets, ctx.binary)
	};
	const post = parse(await ctx.run(SESSION_PHP));
	const prefix = parse(await ctx.run(FILE_CACHE_PHP));
	const db = ctx.drupal.database();
	const cronRow = db
		.prepare(
			"SELECT value FROM key_value WHERE collection = 'state' AND name = 'system.cron_key'"
		)
		.get();
	const cronKey = cronRow
		? /"([^"]+)"/.exec(Buffer.from(cronRow.value).toString())?.[1]
		: undefined;
	const packSettings = new TextDecoder().decode(
		ctx.binary.FS.readFile('/drupal/sites/default/settings.php')
	);
	const needles: Record<string, string> = {
		userName: user.name,
		userMail: user.mail,
		userPass: user.pass,
		sessionSid: user.sid,
		...(cronKey ? { cronKey } : {}),
		...(/hash_salt'\] = '([^']+)'/.exec(packSettings)
			? { packSalt: /hash_salt'\] = '([^']+)'/.exec(packSettings)![1]! }
			: {}),
		...(post.sessionId ? { bakeSessionId: String(post.sessionId) } : {}),
		...(post.csrfSeed ? { bakeCsrfSeed: String(post.csrfSeed) } : {}),
		...(first.permissionsHash ? { permissionsHash: first.permissionsHash } : {}),
		...(first.viewDomId ? { viewDomId: first.viewDomId } : {}),
		...(/[0-9a-f]{64}/.exec(String(prefix.prefix))
			? { fileCachePrefix: /[0-9a-f]{64}/.exec(String(prefix.prefix))![0] }
			: {})
	};
	writeFileSync(path(`${tag}.img`), encodeImage(image));
	writeJson(`${tag}.meta.json`, {
		tag,
		role,
		js,
		pibAsm,
		needles,
		bakeNextMt: post.mt,
		memoryPages: image.byteLength / PAGE,
		firstSha256: first.sha256
	});
	emit({
		kind: 'capture',
		tag,
		role,
		firstSha256: first.sha256,
		firstRawSha256: first.rawSha256,
		status: first.status,
		bytes: first.bytes,
		renderMs: first.ms,
		deltaPages: image.pages.length,
		deltaBytes: image.data.length,
		memoryBytes: image.byteLength,
		imageModule: image.module,
		imageContext: image.context,
		globalsChanged: Object.keys(image.globals ?? {}).length,
		tableSlotsChanged: image.tableSlots?.length ?? 0,
		stackPointer,
		replayHandles: js.handles?.length,
		replayStreams: js.streams?.length,
		keySha16: secrets.key ? sha16(secrets.key) : undefined,
		saltSha16: sha16(secrets.salt),
		cookieName: cookieName ? 'present' : undefined,
		loadedUser: loaded ? { nameLength: String(loaded.name).length } : undefined,
		session: {
			status: post.sessionStatus,
			idLength: String(post.sessionId ?? '').length,
			apiStarted: post.apiStarted,
			apiIdEqualsPhpId: post.apiId === post.sessionId,
			sessionRows: ctx.drupal.database().prepare('SELECT count(*) AS n FROM sessions').get()
				.n,
			csrfSeedLength: String(post.csrfSeed ?? '').length
		},
		bakeNextMtRand: post.mt?.[0],
		needleNames: Object.keys(needles),
		openMs: ctx.marks.openMs
	});
	ctx.drupal.close();
}

function stubImports(module: WebAssembly.Module, memory: WebAssembly.Memory) {
	const imports: Record<string, Record<string, unknown>> = {};
	for (const item of WebAssembly.Module.imports(module)) {
		imports[item.module] ??= {};
		imports[item.module]![item.name] =
			item.kind === 'memory'
				? memory
				: item.kind === 'global'
					? new WebAssembly.Global({ value: 'i32', mutable: true }, 0)
					: () => 0;
	}
	return imports as WebAssembly.Imports;
}

const replayOf = (meta: Row): Replay => ({
	asm: meta.pibAsm.filter((call: Row) => call.sig === ''),
	stackPointer: meta.js.stackPointer,
	sealed: meta.js.sealed,
	streams: meta.js.streams,
	handles: meta.js.handles
});

const label = (value: string, real: string, bake: string) =>
	value === sha16(real) ? 'real' : value === sha16(bake) ? 'bake' : 'other';

/** the site's key and salt are `real`; the sentinel the image was baked with is `bake` */
async function replay(test: string, variant: string, tag: string, index: number, via: string) {
	const real = JSON.parse(readFileSync(path('real.secrets.json'), 'utf8'));
	const bake = JSON.parse(readFileSync(path(`${tag}.secrets.json`), 'utf8'));
	const meta = JSON.parse(readFileSync(path(`${tag}.meta.json`), 'utf8'));
	// the apply route copies memory only; the census and the stack bounds row show what that leaves
	const expect = { module: interp.wasmSha256, context: contextDigest(), memoryOnly: true };
	const image =
		via === 'apply' ? decodeImage(new Uint8Array(readFileSync(path(`${tag}.img`)))) : undefined;
	const bytes = via === 'apply' ? readFileSync(original) : readFileSync(path(`${tag}.wasm`));
	const tc = now();
	const module = new WebAssembly.Module(bytes);
	const compileMs = now() - tc;
	const ctx = await openContext(module, {
		baked: true,
		pages: meta.memoryPages,
		replay: replayOf(meta),
		apply: image && { image, expect },
		key: real.key,
		salt: real.salt
	});
	const parts = variants[variant]!;
	const rekeyed = parts.salt || parts.key || parts.rng || parts.memory;
	let rekeyMs: number | undefined;
	if (rekeyed) {
		const t = now();
		await ctx.run('<?php ' + rekeyCode(real.salt, parts));
		rekeyMs = now() - t;
	}
	const rng = parse(await ctx.run(RNG_PHP));
	const probe = async () => {
		const csrf = parse(await ctx.run(csrfCode([])));
		return {
			token: csrf.token as string,
			keyIs: label(String(csrf.keySha).slice(0, 16), real.key, bake.key),
			saltIs: label(String(csrf.saltSha).slice(0, 16), real.salt, bake.salt),
			sessionIdIsBaked: csrf.sessionId === meta.needles.bakeSessionId
		};
	};
	const pre = await probe();
	const front = await render(ctx, '/');
	const post = await probe();
	emit({
		kind: 'replay',
		test,
		variant,
		via,
		index,
		compileMs,
		rekeyMs,
		openMs: ctx.marks.openMs,
		applyMs: ctx.marks.applyMs,
		mtRand: rng.mtRand,
		uniqid: rng.uniqid,
		uniqidMore: rng.uniqidMore,
		randomInt: rng.randomInt,
		bakeNextMtRand: meta.bakeNextMt?.[0],
		pre,
		post,
		status: front.status,
		renderSha256: front.sha256,
		renderRawSha256: front.rawSha256,
		permissionsHash: front.permissionsHash
	});
	ctx.drupal.close();
}

/** a plain boot of the original module in a site with the given key and salt, then the tokens */
async function reference(config: string, tag: string, index: number) {
	const real = JSON.parse(readFileSync(path('real.secrets.json'), 'utf8'));
	const bake = JSON.parse(readFileSync(path(`${tag}.secrets.json`), 'utf8'));
	const site = config === 'real' ? real : bake;
	const tokens: Row[] = JSON.parse(readFileSync(path('tokens.json'), 'utf8'));
	const ctx = await openContext(original8(), { key: site.key, salt: site.salt });
	const front = await render(ctx, '/');
	const csrf = parse(await ctx.run(csrfCode(tokens.map((entry) => entry.token))));
	emit({
		kind: 'reference',
		config,
		index,
		openMs: ctx.marks.openMs,
		token: csrf.token,
		keySha16: String(csrf.keySha).slice(0, 16),
		saltSha16: String(csrf.saltSha).slice(0, 16),
		status: front.status,
		renderSha256: front.sha256,
		renderRawSha256: front.rawSha256,
		permissionsHash: front.permissionsHash,
		validations: tokens.map((entry, i) => ({
			variant: entry.variant,
			via: entry.via,
			phase: entry.phase,
			valid: csrf.valid[i] === true
		}))
	});
	ctx.drupal.close();
}

/** one arm in one fresh process, the first context only, timed from open to the end of the first render */
async function arm(name: string, round: number) {
	const real = JSON.parse(readFileSync(path('real.secrets.json'), 'utf8'));
	const meta = JSON.parse(readFileSync(path('sentinel-a.meta.json'), 'utf8'));
	const baked = name !== 'plain';
	const tc = now();
	const module = new WebAssembly.Module(
		baked ? readFileSync(path('sentinel-a.wasm')) : readFileSync(original)
	);
	const compileMs = now() - tc;
	const ctx = await openContext(
		module,
		baked
			? {
					baked: true,
					pages: meta.memoryPages,
					replay: replayOf(meta),
					key: real.key,
					salt: real.salt
				}
			: { key: real.key, salt: real.salt }
	);
	let rekeyMs = 0;
	if (name === 'rekeyed') {
		const t = now();
		await ctx.run('<?php ' + rekeyCode(real.salt, variants.full!));
		rekeyMs = now() - t;
	}
	const first = await render(ctx, '/');
	emit({
		kind: 'arm',
		arm: name,
		round,
		compileMs,
		openMs: ctx.marks.openMs,
		rekeyMs: name === 'rekeyed' ? rekeyMs : undefined,
		firstRenderMs: first.ms,
		firstSha256: first.sha256,
		status: first.status,
		totalMs: ctx.marks.openMs + rekeyMs + first.ms,
		rssBytes: process.memoryUsage().rss
	});
	ctx.drupal.close();
}

const FILE_CACHE_PHP = `<?php
echo json_encode(['prefix' => Drupal\\Core\\Site\\Settings::getApcuPrefix('file_cache', DRUPAL_ROOT)]);`;

const STACK_PHP = `<?php
function folio_deep($n) { return array_map('folio_deep', [$n + 1]); }
try {
	folio_deep(0);
	echo json_encode(['returned' => true]);
} catch (Throwable $e) {
	echo json_encode(['class' => get_class($e), 'message' => substr($e->getMessage(), 0, 90)]);
}`;

const BRIDGE_PHP = `<?php echo json_encode([
	'process' => vrzno_env('process'),
	'globalThis' => vrzno_env('globalThis'),
	'require' => vrzno_env('require'),
	'cfwSqlExecIsObject' => is_object(vrzno_env('cfwSqlExec'))
]);`;

/** what each handle PHP holds points at: the frozen root, a sealed cfw wrapper, or something else */
function handleAudit(binary: any, originals: Record<string, unknown>) {
	const root = binary.__cfwRoot;
	const sealed = new Map<unknown, string>();
	for (const name of Object.keys(binary))
		if (/^cfw[A-Za-z0-9]*$/.test(name) && typeof binary[name] === 'function') {
			for (const f of [binary[name], originals[name]]) {
				const wrapper = binary.__cfwSealed?.get(f);
				if (wrapper) sealed.set(wrapper, name);
			}
		}
	const handles: Row[] = [];
	for (const [id, object] of binary.targets.byInteger as Iterable<[number, any]>)
		handles.push({
			id: Number(id),
			is:
				object === root
					? 'cfwRoot'
					: object === globalThis
						? 'globalThis'
						: sealed.has(object)
							? `sealed:${sealed.get(object)}`
							: 'other',
			sealedPrototype:
				typeof object === 'function' ? Object.getPrototypeOf(object) === null : undefined
		});
	return {
		handles: handles.sort((a, b) => a.id - b.id),
		rootFrozen: Object.isFrozen(root),
		rootPrototypeNull: Object.getPrototypeOf(root) === null,
		rootKeys: Reflect.ownKeys(root).length,
		rootIsGlobalThis: root === globalThis
	};
}

/**
 * one replay of the sentinel image through the baked module (via baked) or applyImage (via apply),
 * or a plain boot for contrast (via plain), counting every call the module makes into the host. phase open covers instantiation and the
 * harness's own JS setup, replay covers the handle and descriptor replay, rekey and request are
 * the first PHP that runs.
 */
async function census(via: string, index: number) {
	const real = JSON.parse(readFileSync(path('real.secrets.json'), 'utf8'));
	const meta = JSON.parse(readFileSync(path('sentinel-a.meta.json'), 'utf8'));
	const image =
		via === 'apply'
			? decodeImage(new Uint8Array(readFileSync(path('sentinel-a.img'))))
			: undefined;
	const bytes = via === 'baked' ? readFileSync(path('sentinel-a.wasm')) : readFileSync(original);
	const counter: Census = { phase: 'open', harness: false, calls: {}, originals: {} };
	const ctx = await openContext(
		new WebAssembly.Module(bytes),
		via === 'plain'
			? { key: real.key, salt: real.salt, census: counter }
			: {
					baked: true,
					pages: meta.memoryPages,
					replay: replayOf(meta),
					apply: image && {
						image,
						expect: {
							module: interp.wasmSha256,
							context: contextDigest(),
							memoryOnly: true
						}
					},
					key: real.key,
					salt: real.salt,
					census: counter
				}
	);
	counter.phase = 'idle';
	const afterReplay = handleAudit(ctx.binary, counter.originals);
	const callsBeforeFirstPhp = JSON.parse(JSON.stringify(counter.calls));
	counter.phase = 'rekey';
	await ctx.run('<?php ' + rekeyCode(real.salt, variants.full!));
	counter.phase = 'request';
	const front = await render(ctx, '/');
	counter.phase = 'bridge-probe';
	const bridge = parse(await ctx.run(BRIDGE_PHP));
	const exports = ctx.instance.exports as Record<string, any>;
	const stack = Object.fromEntries(
		['emscripten_stack_get_base', 'emscripten_stack_get_end', 'emscripten_stack_get_free'].map(
			(name) => [name, Number(exports[name]?.() ?? NaN)]
		)
	);
	counter.phase = 'stack-probe';
	const deep = await ctx.run(STACK_PHP).then(
		(raw) => parse(raw),
		(error) => ({ thrown: String(error?.stack ?? error).slice(0, 160) })
	);
	emit({
		kind: 'census',
		via,
		index,
		replay: ctx.marks.replay,
		handlesAfterReplay: afterReplay,
		calls: callsBeforeFirstPhp,
		callsByPhase: counter.calls,
		bridgeProbe: bridge,
		stackGlobals: stack,
		deepRecursion: deep,
		status: front.status,
		renderSha256: front.sha256
	});
	ctx.drupal.close();
}

const [childMode, , ...args] = process.argv.slice(2);
if (childMode === 'capture') await capture(args[0]!, args[1] as Role);
else if (childMode === 'replay')
	await replay(args[0]!, args[1]!, args[2]!, Number(args[3]), args[4]!);
else if (childMode === 'reference') await reference(args[0]!, args[1]!, Number(args[2]));
else if (childMode === 'arm') await arm(args[0]!, Number(args[1]));
else if (childMode === 'census') await census(args[0]!, Number(args[1]));
else throw new Error(`unknown child mode ${childMode}`);

// #endregion
