import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { governGrowth } from '../../src/growth-governor.ts';

const ARMS = ['open', 'capped', 'capped-fit', 'capped-trycatch'];
const arm = process.argv[2];
if (!ARMS.includes(arm)) throw new Error(`arm must be one of ${ARMS.join(', ')}; got "${arm}"`);
const label = process.argv[3] ?? '1';

const need = (name, hint) => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required; ${hint}`);
	return value;
};
const WASM = need('PHP_WASM', 'set it to the Emscripten PHP module (.wasm)');
const GLUE = need('PHP_GLUE', 'set it to the Emscripten glue of that module (.mjs)');
const PHP_BASE = need('PHP_BASE', 'set it to PhpBase.mjs from the public php-wasm package');
const OUT = process.env.OUT ?? fileURLToPath(new URL('./runs', import.meta.url));

const MiB = 1048576;
// only used when the binary imports its memory; the PHP 8.5 module does not
const INITIAL_PAGES = 1024;
const MAXIMUM_PAGES = 65536;
// boot memory is 96 MiB; capped is boot + 8 MiB, capped-fit is boot + 64 MiB
const DEFAULT_CAP = { capped: 109051904, 'capped-trycatch': 109051904, 'capped-fit': 167772160 };
const cap =
	(arm === 'capped' || arm === 'capped-trycatch') && process.env.CAP_BYTES
		? Number(process.env.CAP_BYTES)
		: (DEFAULT_CAP[arm] ?? null);

// the glue reads self.location.href on load in its worker branch; workerd has it, node does not
globalThis.self = { location: { href: import.meta.url } };

// removing disable_functions moves the try arm's first grow by 4 KiB
const DISABLED = [
	'sleep',
	'usleep',
	'time_nanosleep',
	'time_sleep_until',
	'uniqid',
	'exec',
	'shell_exec',
	'system',
	'passthru',
	'proc_open',
	'popen',
	'pclose',
	'proc_get_status',
	'proc_close',
	'proc_terminate',
	'extension_loaded',
	'get_loaded_extensions',
	'get_extension_funcs'
];
const ini = [
	'opcache.enable=0',
	'opcache.enable_cli=0',
	'memory_limit=96M',
	`disable_functions=${DISABLED.join(',')}`
].join('\n');

const { PhpBase } = await import(pathToFileURL(PHP_BASE).href);
const { default: factory } = await import(pathToFileURL(GLUE).href);
const wasmModule = new WebAssembly.Module(readFileSync(WASM));
const importsMemory = WebAssembly.Module.imports(wasmModule).some((i) => i.kind === 'memory');

const log = {
	arm,
	capBytes: cap,
	importsMemory,
	iniSha256: createHash('sha256').update(ini).digest('hex'),
	boot: {},
	events: []
};
const note = (src, data) => log.events.push({ src, ...data });
const state = {
	armed: false,
	memory: null,
	instance: null,
	refusals: [],
	growths: [],
	calls: 0,
	governor: null
};

const liveMemory = () => state.instance?.exports?.memory ?? state.memory;
const bytes = () => liveMemory().buffer.byteLength;

const php = new PhpBase(Promise.resolve({ default: factory }), {
	ini,
	printErr: (t) => note('printErr', { t: String(t) }),
	onAbort: (what) => note('onAbort', { what: String(what) }),
	instantiateWasm(wasmImports, receiveInstance) {
		state.memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: MAXIMUM_PAGES });
		if (importsMemory) wasmImports.env.memory = state.memory;
		const original = wasmImports.env.emscripten_resize_heap;
		wasmImports.env.emscripten_resize_heap = (requested) => {
			state.calls += 1;
			const bytesBefore = state.instance ? bytes() : null;
			const returned = original(requested);
			state.growths.push({
				requested,
				armed: state.armed,
				returned,
				bytesBefore,
				bytesAfter: state.instance ? bytes() : null
			});
			return returned;
		};
		WebAssembly.instantiate(wasmModule, wasmImports)
			.then((instance) => {
				state.instance = instance;
				receiveInstance(instance, wasmModule);
			})
			.catch((e) => note('instantiate', { err: String(e) }));
		return {};
	}
});

const outputs = [];
php.addEventListener('output', (e) => outputs.push(String(e.detail)));
php.addEventListener('error', (e) => outputs.push(`[error] ${String(e.detail)}`));

const withTimeout = (p, ms, step) => {
	let timer;
	const timeout = new Promise((_, rej) => {
		timer = setTimeout(() => rej(new Error(`timeout: ${step}`)), ms);
	});
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};
const describe = (e) => ({
	name: e?.name ?? null,
	message: String(e?.message ?? e),
	status: e?.status ?? null
});

try {
	const binary = await withTimeout(php.binary, 60000, 'boot');
	log.boot.memoryBytes = bytes();
	log.boot.exec11 = await php._exec('1+1');
	log.boot.memoryAfterBoot = bytes();
	log.boot.memoryImported = importsMemory;
	log.boot.capBytes = cap;
	log.boot.bootBytesAtCap = bytes();

	state.armed = arm !== 'open';
	if (state.armed) {
		state.governor = governGrowth(liveMemory(), {
			capBytes: cap,
			onRefuse: (info) => state.refusals.push(info)
		});
	}
	const code =
		arm === 'capped-trycatch'
			? "<?php try { $GLOBALS['p'] = str_repeat('x', 64*1048576); echo 'completed'; } catch (\\Throwable $e) { echo 'caught'; }"
			: "<?php $GLOBALS['p'] = str_repeat('x', 64*1048576);";
	const before = bytes();
	const eventsBefore = log.events.length;
	const outputsBefore = outputs.length;
	log.big = { bytesBefore: before };
	let runReturn = null;
	try {
		runReturn = await php._run(code);
		log.big.runReturn = runReturn;
	} catch (e) {
		log.big.threw = describe(e);
	}
	log.big.bytesAfter = bytes();
	log.big.newEvents = log.events.slice(eventsBefore);
	log.big.newOutput = outputs.slice(outputsBefore);
	log.big.refusals = state.refusals;
	log.big.allowedMemorySizeSeen = [
		...log.big.newEvents.map((x) => x.t ?? ''),
		...log.big.newOutput
	].some((s) => String(s).includes('Allowed memory size'));

	if (arm === 'open' || arm === 'capped-fit') {
		const digest = log.big.threw ? null : await php._exec("hash('sha256',$GLOBALS['p'])");
		const expected = createHash('sha256')
			.update(Buffer.alloc(64 * MiB, 0x78))
			.digest('hex');
		log.digest = { digest, expected, match: digest === expected };
	}
	if (arm !== 'open') {
		let alive = true;
		try {
			await binary.ccall('php_request_shutdown', null, ['number'], [0]);
		} catch (e) {
			alive = false;
			log.instanceAfterFatal = { alive, shutdownThrew: describe(e) };
		}
		if (alive) {
			log.instanceAfterFatal = { alive: true };
			try {
				log.instanceAfterFatal.startup = await binary.ccall(
					'php_request_startup',
					'number',
					[],
					[]
				);
			} catch (e) {
				log.instanceAfterFatal.startupThrew = describe(e);
			}
			try {
				log.instanceAfterFatal.exec11 = await php._exec('1+1');
			} catch (e) {
				log.instanceAfterFatal.execThrew = describe(e);
			}
		}
		log.instanceAfterFatal.memoryFinal = bytes();
		log.instanceAfterFatal.refusalCount = state.refusals.length;
	}
} catch (e) {
	log.fatalHarness = describe(e);
}

log.outputs = outputs;
log.glueCalls = state.calls;
log.growths = state.growths;

mkdirSync(OUT, { recursive: true });
const file = join(OUT, `${arm}-${label}.json`);
writeFileSync(file, `${JSON.stringify(log, null, 2)}\n`);
console.log(`wrote ${file}`);
