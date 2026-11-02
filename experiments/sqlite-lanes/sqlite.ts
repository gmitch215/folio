export const PAGE_BYTES = 65536;
// must equal --initial-memory in prepare.ts; the host memory may not be smaller than the module declares
export const MODULE_MIN_PAGES = 256;
export const SQLITE_VERSION = 3050004;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface Exports {
	io_ptr(): number;
	io_bytes(): number;
	err_ptr(): number;
	err_len(): number;
	lib_version(): number;
	open_empty(): number;
	exec(n: number): number;
	image_alloc(n: number): number;
	open_image(p: number, n: number): number;
	query_text(n: number): number;
	vm_steps(): bigint;
	serialize(): number;
	serial_len(): bigint;
}

export function sharedMemory(maxPages: number) {
	return new WebAssembly.Memory({ initial: MODULE_MIN_PAGES, maximum: maxPages, shared: true });
}

export class Sqlite {
	readonly exports: Exports;
	private readonly memory: WebAssembly.Memory;
	private image = 0;
	private imageBytes = 0;

	constructor(module: WebAssembly.Module, memory: WebAssembly.Memory) {
		this.memory = memory;
		this.exports = new WebAssembly.Instance(module, { env: { memory } })
			.exports as unknown as Exports;
		const version = this.exports.lib_version();
		if (version !== SQLITE_VERSION)
			throw new Error(`sqlite ${version} is not ${SQLITE_VERSION}`);
	}

	// the image is copied in parts, each part at its offset; openImage reads the whole in place
	beginImage(total: number) {
		const at = this.exports.image_alloc(total);
		if (!at) throw new Error(`image_alloc(${total}) failed`);
		this.image = at;
		this.imageBytes = total;
	}

	writeImage(offset: number, bytes: Uint8Array) {
		if (offset + bytes.length > this.imageBytes) throw new Error('image part past the end');
		this.view(this.image + offset, bytes.length).set(bytes);
	}

	openImage() {
		const rc = this.exports.open_image(this.image, this.imageBytes);
		if (rc) throw new Error(`open_image failed (${rc}): ${this.error()}`);
	}

	exec(sql: string) {
		const bytes = encoder.encode(sql);
		this.io().set(bytes, 0);
		const rc = this.exports.exec(bytes.length);
		if (rc) throw new Error(`exec failed (${rc}): ${this.error()}`);
	}

	// returns the text rows and the VDBE step count of the statement
	query(sql: string) {
		const bytes = encoder.encode(sql);
		this.io().set(bytes, 0);
		const n = this.exports.query_text(bytes.length);
		if (n < 0) throw new Error(`query failed (${n}): ${this.error()}: ${sql.slice(0, 120)}`);
		const text = decoder.decode(this.io().subarray(0, n));
		return { text, vmSteps: Number(this.exports.vm_steps()) };
	}

	openEmpty() {
		if (this.exports.open_empty()) throw new Error(`open_empty failed: ${this.error()}`);
	}

	// a copy of the serialized database, for the builder only
	serialize() {
		const at = this.exports.serialize();
		if (!at) throw new Error('serialize returned null');
		return this.view(at, Number(this.exports.serial_len())).slice();
	}

	private io() {
		return this.view(this.exports.io_ptr(), this.exports.io_bytes());
	}

	private view(at: number, n: number) {
		return new Uint8Array(this.memory.buffer, at, n);
	}

	private error() {
		return decoder.decode(this.view(this.exports.err_ptr(), this.exports.err_len()));
	}
}
