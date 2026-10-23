import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import { bakeModule, captureImage, checkBaked, encodeImage, moduleDigest } from '../../src/bake.ts';

/** a descriptor the image must reopen */
export interface StreamRow {
	fd: number;
	path: string;
	flags: number;
	position: number;
	seekable?: boolean;
	nodeId?: number | null;
	isDir?: boolean;
}

/** one recorded call of an emscripten_asm_const import */
export interface AsmRow {
	stage: string;
	key: string;
	args: number[];
}

/** a heap read back out of a product Durable Object database */
export interface StoredHeap {
	heap: Uint8Array;
	streams: StreamRow[];
	handles: { id: number; name: string }[];
	generation: string;
	keptPages: number;
}

const PAGE = 65_536;

/** inflates the stored rows (raw deflate, or the bytes as stored when the row's raw length is 0) */
export function joinRows(rows: { seq: number; bytes: Uint8Array; raw_bytes: number }[]) {
	const parts = [...rows]
		.sort((a, b) => a.seq - b.seq)
		.map((row, at) => {
			if (row.seq !== at) throw new Error(`chunk ${at} is missing (found ${row.seq})`);
			if (row.raw_bytes <= 0) return row.bytes;
			const out = inflateRawSync(row.bytes);
			if (out.length !== row.raw_bytes)
				throw new Error(
					`chunk ${row.seq} inflated to ${out.length}, row says ${row.raw_bytes}`
				);
			return new Uint8Array(out.buffer, out.byteOffset, out.length);
		});
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const joined = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		joined.set(part, at);
		at += part.length;
	}
	return joined;
}

/** puts the kept pages back at their page numbers in a heap of `byteLength` bytes */
export function reassemble(kept: Uint8Array, pageIndex: number[], byteLength: number) {
	if (kept.length !== pageIndex.length * PAGE)
		throw new Error(`${pageIndex.length} kept pages but ${kept.length} bytes`);
	const heap = new Uint8Array(byteLength);
	pageIndex.forEach((page, i) => {
		if (page < 0 || (page + 1) * PAGE > byteLength)
			throw new Error(`page ${page} is outside the heap`);
		heap.set(kept.subarray(i * PAGE, (i + 1) * PAGE), page * PAGE);
	});
	return heap;
}

/** reads the newest heap snapshot of a product object database */
export function readStoredHeap(db: DatabaseSync): StoredHeap {
	const meta = db.prepare('SELECT * FROM cfw_heap_snapshot ORDER BY id DESC LIMIT 1').get() as
		Record<string, any> | undefined;
	if (!meta) throw new Error('no heap snapshot in this database');
	const rows = db
		.prepare(
			'SELECT seq, bytes, raw_bytes FROM cfw_heap_chunk WHERE snapshot_id = ? ORDER BY seq'
		)
		.all(meta.id) as { seq: number; bytes: Uint8Array; raw_bytes: number }[];
	const pageIndex = JSON.parse(String(meta.page_index)) as number[];
	return {
		heap: reassemble(joinRows(rows), pageIndex, Number(meta.byte_length)),
		streams: JSON.parse(String(meta.fd_table)) as StreamRow[],
		handles: JSON.parse(String(meta.handle_table)) as { id: number; name: string }[],
		generation: String(meta.generation),
		keptPages: pageIndex.length
	};
}

/**
 * The calls to replay for `pib_init`. The signature and argument pointers were stack addresses of
 * the capture, so each call goes back as (code, 0, 0), the form the boot-image harness replayed.
 */
export function pibInitReplay(trace: AsmRow[]): AsmRow[] {
	return trace
		.filter((call) => call.stage === 'pib_init')
		.map((call) => ({ stage: 'pib_init', key: call.key, args: [call.args[0]!, 0, 0] }));
}

/** the pages the first heap carries that the second does not, as a count of differing pages */
export function differingPages(a: Uint8Array, b: Uint8Array): number {
	if (a.length !== b.length) return Math.max(a.length, b.length) / PAGE;
	let count = 0;
	for (let page = 0; page < a.length / PAGE; page++) {
		const x = a.subarray(page * PAGE, (page + 1) * PAGE);
		const y = b.subarray(page * PAGE, (page + 1) * PAGE);
		if (Buffer.compare(x, y) !== 0) count++;
	}
	return count;
}

export interface BakedSource {
	pages: number;
	context: string;
	asm: AsmRow[];
	streams: StreamRow[];
	handles: { id: number; name: string }[];
	image: string;
	assets?: string;
	config?: string;
	globals?: Record<string, number>;
	plainFallback: boolean;
}

/** the generated `src/hostboot/baked.ts` of a clone */
export function bakedSource(meta: BakedSource | null): string {
	const head = `export type AsmCall = { stage: string; key: string; args: number[] };

export type BakedMeta = {
	pages: number;
	context: string;
	asm: AsmCall[];
	streams: {
		fd: number;
		path: string;
		flags: number;
		position: number;
		seekable?: boolean;
		nodeId?: number | null;
		isDir?: boolean;
	}[];
	handles: { id: number; name: string }[];
	image: string;
	assets?: string;
	config?: string;
	globals?: Record<string, number>;
};
`;
	if (!meta)
		return `${head}
export const BAKED: BakedMeta | null = null;
export const PLAIN_MODULE: WebAssembly.Module | null = null;
`;
	const { plainFallback, ...rest } = meta;
	return `${plainFallback ? "import plain from '../../.interp/php8.5.plain.wasm';\n" : ''}${head}
export const BAKED: BakedMeta | null = ${JSON.stringify(rest, null, '\t')};
export const PLAIN_MODULE: WebAssembly.Module | null = ${plainFallback ? '(plain as unknown as WebAssembly.Module)' : 'null'};
`;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

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

/** the memory of a fresh instance of the module, which has only the module's own data */
function freshMemory(wasm: Uint8Array): WebAssembly.Memory {
	const module = new WebAssembly.Module(wasm as BufferSource);
	const memory = new WebAssembly.Memory({ initial: 1024, maximum: 65_536 });
	new WebAssembly.Instance(module, stubImports(module, memory));
	return memory;
}

/**
 * The wasm global each getter export reads, with its initial value. An emscripten module keeps its
 * stack pointer, stack limits and return register in mutable globals that only a getter export can
 * read back, and a getter's body is one `global.get`.
 */
export async function getterGlobals(wasm: Uint8Array, getters: string[]) {
	const binaryen: any = (await import('binaryen')).default;
	const mod = binaryen.readBinary(wasm);
	try {
		const exported = new Map<string, string>();
		for (let i = 0; i < mod.getNumExports(); i++) {
			const info = binaryen.getExportInfo(mod.getExportByIndex(i));
			exported.set(info.name, info.value);
		}
		const indexOf = new Map<string, number>();
		for (let i = 0; i < mod.getNumGlobals(); i++)
			indexOf.set(binaryen.getGlobalInfo(mod.getGlobalByIndex(i)).name, i);
		const found: Record<string, { index: number; initial: number }> = {};
		for (const getter of getters) {
			const target = exported.get(getter);
			if (target === undefined) continue;
			const body = binaryen.getExpressionInfo(
				binaryen.getFunctionInfo(mod.getFunction(target)).body
			);
			if (body.id !== binaryen.GlobalGetId)
				throw new Error(`${getter} does not read one global`);
			const index = indexOf.get(body.name)!;
			const global = binaryen.getGlobalInfo(mod.getGlobalByIndex(index));
			if (!global.mutable) continue;
			const initial = binaryen.getExpressionInfo(global.init).value;
			if (typeof initial !== 'number') throw new Error(`global ${index} is not an i32`);
			found[getter] = { index, initial };
		}
		return found;
	} finally {
		mod.dispose();
	}
}

interface CliOptions {
	sqlite: string;
	meta: string;
	dump?: string;
	wasm: string;
	out: string;
	name: string;
}

/** reads one capture, bakes the module, writes the baked module and the clone's generated source */
export async function bake(options: CliOptions) {
	const meta = JSON.parse(readFileSync(options.meta, 'utf8'));
	const tmp = `${options.out}/${options.name}.sqlite`;
	mkdirSync(options.out, { recursive: true });
	copyFileSync(options.sqlite, tmp);
	for (const ext of ['-wal', '-shm']) {
		try {
			copyFileSync(options.sqlite + ext, tmp + ext);
		} catch {
			// no wal file means nothing is pending
		}
	}
	const db = new DatabaseSync(tmp, { readOnly: true });
	const stored = readStoredHeap(db);
	db.close();
	const dump = options.dump ? new Uint8Array(readFileSync(options.dump)) : null;
	const wasm = new Uint8Array(readFileSync(options.wasm));
	const digest = await moduleDigest(wasm);
	const context = `${meta.context}|module=${digest}`;
	const read = (meta.globals ?? {}) as Record<string, number>;
	const located = await getterGlobals(wasm, Object.keys(read));
	const booted: Record<number, number> = {};
	const fresh: Record<number, number> = {};
	for (const [name, { index, initial }] of Object.entries(located)) {
		booted[index] = read[name]!;
		fresh[index] = initial;
	}
	const image = captureImage(stored.heap, freshMemory(wasm), {
		module: digest,
		context,
		globals: { booted, fresh }
	});
	const baked = await bakeModule(wasm, image);
	const check = checkBaked(baked, image);
	const imageBytes = encodeImage(image);
	writeFileSync(`${options.out}/${options.name}.image`, imageBytes);
	writeFileSync(`${options.out}/${options.name}.wasm`, baked);
	const source: BakedSource = {
		pages: image.byteLength / PAGE,
		context: meta.context,
		asm: pibInitReplay(meta.trace),
		streams: stored.streams,
		handles: stored.handles,
		image: sha256(imageBytes),
		globals: Object.fromEntries(Object.keys(located).map((name) => [name, read[name]!])),
		plainFallback: false
	};
	writeFileSync(`${options.out}/${options.name}.json`, JSON.stringify(source));
	return {
		name: options.name,
		moduleSha256: digest,
		bakedSha256: sha256(baked),
		bakedBytes: baked.length,
		imageSha256: source.image,
		heapBytes: stored.heap.length,
		memoryPages: source.pages,
		keptPages: stored.keptPages,
		deltaPages: image.pages.length,
		globalsChanged: image.globals ?? {},
		checkEqual: check.equal,
		dumpEqual: dump ? differingPages(stored.heap, dump) === 0 : null,
		dumpDifferingPages: dump ? differingPages(stored.heap, dump) : null,
		streams: stored.streams.length,
		handles: stored.handles.length,
		asmReplay: source.asm.length,
		generation: stored.generation
	};
}

if (import.meta.main) {
	const [mode, ...rest] = process.argv.slice(2);
	if (mode === 'bake') {
		const [sqlite, meta, dump, wasm, out, name] = rest;
		console.log(
			JSON.stringify(
				await bake({
					sqlite: sqlite!,
					meta: meta!,
					dump: dump === '-' ? undefined : dump,
					wasm: wasm!,
					out: out!,
					name: name!
				})
			)
		);
	} else if (mode === 'source') {
		const [file, json, fallback, ...extra] = rest;
		const meta =
			json && json !== '-' ? (JSON.parse(readFileSync(json, 'utf8')) as BakedSource) : null;
		if (meta) {
			meta.plainFallback = fallback === 'plain';
			for (const item of extra) {
				const [key, value] = item.split('=');
				if (key === 'assets' || key === 'config') meta[key] = value;
			}
		}
		writeFileSync(file!, bakedSource(meta));
	} else if (mode !== 'assets') {
		console.error(
			'usage: product-bake.ts bake <sqlite> <meta.json> <dump|-> <wasm> <outdir> <name> | source <file> <json|-> [plain|none] [assets=<index path>] [config=<digest>]'
		);
		process.exit(2);
	}
}

/** a 32-bit hash over the little-endian words of one page; the same loop runs in the clone */
export function pageHash(page: Uint8Array): number {
	// an image decoded from a file can start a page at an offset that is not a multiple of 4
	const aligned = page.byteOffset % 4 === 0 ? page : page.slice();
	const words = new Int32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength >> 2);
	let hash = 0;
	for (let i = 0; i < words.length; i++) hash = (Math.imul(hash, 31) + words[i]!) | 0;
	return hash;
}

export interface AssetIndex {
	version: 1;
	pageBytes: number;
	memoryPages: number;
	module?: string;
	context?: string;
	chunks: { file: string; pages: number[]; hashes: number[] }[];
}

/**
 * Splits an image into files of at most `chunkPages` pages. The index lists, per file, the page
 * numbers in file order and a hash of each page, so a smaller page list is the same format.
 */
export function chunkImage(
	image: {
		byteLength: number;
		pages: number[];
		data: Uint8Array;
		module?: string;
		context?: string;
	},
	chunkPages: number
) {
	if (!Number.isInteger(chunkPages) || chunkPages < 1)
		throw new RangeError('chunkPages must be a positive integer');
	const index: AssetIndex = {
		version: 1,
		pageBytes: PAGE,
		memoryPages: image.byteLength / PAGE,
		module: image.module,
		context: image.context,
		chunks: []
	};
	const files: Record<string, Uint8Array> = {};
	for (let at = 0; at < image.pages.length; at += chunkPages) {
		const pages = image.pages.slice(at, at + chunkPages);
		const bytes = image.data.subarray(at * PAGE, (at + pages.length) * PAGE);
		const file = `c${String(index.chunks.length).padStart(3, '0')}.bin`;
		files[file] = bytes;
		const hashes = pages.map((_, i) => pageHash(bytes.subarray(i * PAGE, (i + 1) * PAGE)));
		index.chunks.push({ file, pages, hashes });
	}
	return { index, files };
}

if (import.meta.main && process.argv[2] === 'assets') {
	const { decodeImage } = await import('../../src/bake.ts');
	const [, , , imageFile, outDir, chunkPages] = process.argv;
	const image = decodeImage(new Uint8Array(readFileSync(imageFile!)));
	const { index, files } = chunkImage(image, Number(chunkPages ?? 64));
	mkdirSync(outDir!, { recursive: true });
	writeFileSync(`${outDir}/index.json`, JSON.stringify(index));
	for (const [name, bytes] of Object.entries(files)) writeFileSync(`${outDir}/${name}`, bytes);
	console.log(
		JSON.stringify({
			files: Object.keys(files).length,
			pages: image.pages.length,
			bytes: image.data.length
		})
	);
}
