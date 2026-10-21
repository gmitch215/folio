import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import type { TaskLink } from '../../src/tasks.ts';
import { ownerBridge, serveTasks } from './php-task-bridge.ts';
import { createHooks, type HookConfig } from './worksp-hooks.ts';

// bundled by php-contexts.ts; one worker thread is one private PHP instance
const data = workerData as {
	index: number;
	kind: 'plain' | 'drupal';
	mode: 'native' | 'folio';
	consumer: string;
	interp: string;
	module: WebAssembly.Module;
	plan?: any;
	srcUrl: string;
	workers: number;
	opcache?: string[];
	instrument?: boolean;
	worksp?: HookConfig;
	task?: { links?: TaskLink[]; link?: TaskLink };
};
const port = parentPort!;
const now = () => performance.timeOrigin + performance.now();
const cpu = () => {
	const usage = process.threadCpuUsage();
	return (usage.user + usage.system) / 1000;
};
const g = globalThis as any;
g.self ??= g;
g.location ??= new URL('https://folio.invalid/worker.mjs');

const output: string[] = [];
let pool: any;
let owner: ReturnType<typeof ownerBridge> | undefined;
let php: any;
let drupal: any;
const boot: Record<string, number> = {};
let wasmMemory: WebAssembly.Memory;
let wasmTable: WebAssembly.Table | undefined;
let hooks: ReturnType<typeof createHooks> | undefined;
const indirect = new Map<number, number>();
const ci = (site: number, target: number) => {
	const key = site * 65536 + target;
	indirect.set(key, (indirect.get(key) ?? 0) + 1);
	return target;
};

async function open() {
	const t0 = now();
	const cpu0 = cpu();
	if (data.kind === 'drupal') {
		drupal = await import('./php-context-drupal.ts');
		await drupal.prepare(data.consumer);
		boot.seedMs = now() - t0;
	}
	const { default: Factory } = await import(pathToFileURL(join(data.consumer, data.interp)).href);
	const { PhpBase } = await import(
		pathToFileURL(join(data.consumer, 'node_modules/php-wasm/PhpBase.mjs')).href
	);
	const { Folio } = await import(new URL('node.ts', data.srcUrl).href);
	const t1 = now();
	php = new PhpBase(
		Promise.resolve({ default: Factory }) as any,
		{
			ini: [
				...(data.opcache ?? ['opcache.enable=0', 'opcache.enable_cli=0']),
				...(data.kind === 'drupal'
					? ['memory_limit=96M', drupal.disabled()]
					: ['memory_limit=256M'])
			].join('\n'),
			printErr: () => {},
			instantiateWasm(imports: WebAssembly.Imports, receive: (a: any, b: any) => void) {
				(async () => {
					await Promise.resolve();
					(imports.env as any).memory = wasmMemory = new WebAssembly.Memory(
						data.kind === 'drupal' ? drupal.memory() : { initial: 1024, maximum: 65536 }
					);
					if (data.instrument) (imports as any).folio = { ci };
					if (data.worksp) {
						hooks = createHooks(data.worksp);
						(imports as any).folio = hooks.imports;
						hooks.wrap(imports as any);
					}
					if (data.mode === 'native') {
						const instance = new WebAssembly.Instance(data.module, imports);
						hooks?.attach(instance, wasmMemory);
						wasmTable = Object.values(instance.exports).find(
							(v) => v instanceof WebAssembly.Table
						) as WebAssembly.Table | undefined;
						receive(instance, data.module);
					} else {
						pool = await Folio.open(
							{ ...data.plan, compiled: data.module },
							{ imports, workers: data.workers, profile: true }
						);
						receive({ exports: pool.exports }, data.module);
					}
				})().catch((error) => {
					console.error(error);
					process.exit(1);
				});
				return {};
			}
		} as any
	);
	php.addEventListener('output', (event: any) => output.push(...[].concat(event.detail ?? [])));
	const binary = await php.binary;
	boot.phpBootMs = now() - t1;
	if (data.kind === 'drupal') {
		const t2 = now();
		await drupal.boot(binary, run);
		boot.drupalBootMs = now() - t2;
	}
	if (data.task?.links) {
		owner = ownerBridge(data.task.links);
		binary.cfwTaskSubmit = owner.submit;
		binary.cfwTaskJoin = owner.join;
	}
	if (data.task?.link) serveTasks(data.task.link, run, cpu);
	boot.openMs = now() - t0;
	boot.openCpuMs = cpu() - cpu0;
	return binary;
}

function listFiles(binary: any, dir: string, out: Record<string, Uint8Array>) {
	for (const name of binary.FS.readdir(dir)) {
		if (name === '.' || name === '..') continue;
		const path = `${dir === '/' ? '' : dir}/${name}`;
		const stat = binary.FS.stat(path);
		if (binary.FS.isDir(stat.mode)) listFiles(binary, path, out);
		else out[path] = binary.FS.readFile(path);
	}
	return out;
}

async function run(code: string) {
	output.length = 0;
	if (pool) {
		const encoded = new TextEncoder().encode('?>' + code + '\0');
		const pointer = Number(pool.exports.malloc(encoded.length));
		try {
			new Uint8Array(pool.memory.buffer, pointer, encoded.length).set(encoded);
			await pool.run('pib_run', [pointer]);
			php.flush();
		} finally {
			pool.exports.free(pointer);
		}
	} else await php._run(code);
	return output.join('');
}

let binary: any;
try {
	binary = await open();
	port.postMessage({
		type: 'ready',
		index: data.index,
		threadId: (await import('node:worker_threads')).threadId,
		boot,
		memoryBytes: binary.HEAPU8.buffer.byteLength
	});
} catch (error) {
	port.postMessage({ type: 'error', error: String((error as Error)?.stack ?? error) });
	process.exit(1);
}

port.on('message', async (message: any) => {
	if (message.type === 'close') {
		await pool?.close();
		drupal?.close();
		port.postMessage({ type: 'closed' });
		process.exit(0);
	}
	if (message.type === 'width') {
		owner?.setWidth(message.width);
		port.postMessage({ type: 'result', id: message.id, index: data.index });
		return;
	}
	if (message.type === 'counts') {
		const triples: number[] = [];
		const targets: Record<number, string> = {};
		const table = wasmTable;
		for (const [key, count] of indirect) {
			const target = key % 65536;
			triples.push(Math.floor(key / 65536), target, count);
			if (table && !(target in targets)) targets[target] = String(table.get(target)?.name);
		}
		indirect.clear();
		port.postMessage({ type: 'result', id: message.id, index: data.index, triples, targets });
		return;
	}
	if (message.type === 'memoryOut') {
		const memory = new Uint8Array(wasmMemory.buffer).slice();
		port.postMessage({ type: 'result', id: message.id, index: data.index, memory }, [
			memory.buffer
		]);
		return;
	}
	if (message.type === 'memoryIn') {
		const t0 = now();
		const source = message.memory as Uint8Array;
		const before = wasmMemory.buffer.byteLength;
		if (source.length > before) wasmMemory.grow((source.length - before) / 65536);
		new Uint8Array(wasmMemory.buffer).set(source);
		port.postMessage({
			type: 'result',
			id: message.id,
			index: data.index,
			adoptMs: now() - t0,
			grewBytes: Math.max(0, source.length - before)
		});
		return;
	}
	if (message.type === 'exportFiles') {
		const files = listFiles(binary, message.dir, {});
		port.postMessage({ type: 'result', id: message.id, index: data.index, files });
		return;
	}
	if (message.type === 'importFiles') {
		for (const [path, bytes] of Object.entries(message.files as Record<string, Uint8Array>)) {
			let dir = '';
			for (const part of path.split('/').slice(1, -1)) {
				dir += '/' + part;
				try {
					binary.FS.mkdir(dir);
				} catch {}
			}
			binary.FS.writeFile(path, bytes);
		}
		port.postMessage({ type: 'result', id: message.id, index: data.index });
		return;
	}
	if (message.type === 'worksp') {
		try {
			const code = message.render ? drupal.renderCode() : message.code;
			if (message.render) drupal.resetSql();
			const before = hooks!.snapshot();
			const t0 = hooks!.begin();
			const raw = await run(code);
			const after = hooks!.snapshot();
			const traced = hooks!.end(message.input ?? { id: 'unnamed' }, message.options);
			port.postMessage({
				type: 'result',
				id: message.id,
				index: data.index,
				sha256: message.render
					? drupal.summarize(raw).sha256
					: createHash('sha256').update(raw).digest('hex'),
				outputBytes: raw.length,
				startMs: t0,
				counters: Object.fromEntries(
					Object.keys(after).map((k) => [k, after[k]! - before[k]!])
				),
				traced
			});
		} catch (error) {
			port.postMessage({
				type: 'result',
				id: message.id,
				index: data.index,
				error: String((error as Error)?.stack ?? error)
			});
		}
		return;
	}
	const cpu0 = cpu();
	const start = now();
	try {
		const code = message.type === 'render' ? drupal.renderCode() : message.code;
		if (message.type === 'render') drupal.resetSql();
		const raw = await run(code);
		const end = now();
		const result: any = {
			type: 'result',
			id: message.id,
			index: data.index,
			startMs: start,
			endMs: end,
			cpuMs: cpu() - cpu0,
			memoryBytes: binary.HEAPU8.buffer.byteLength
		};
		if (message.type === 'render') {
			const view = drupal.summarize(raw);
			Object.assign(result, view);
		} else result.sha256 = createHash('sha256').update(raw).digest('hex');
		if (message.keep) result.output = raw;
		if (owner) result.taskLog = owner.drain();
		port.postMessage(result);
	} catch (error) {
		port.postMessage({
			type: 'result',
			id: message.id,
			index: data.index,
			error: String((error as Error)?.stack ?? error)
		});
	}
});
