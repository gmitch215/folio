/** byte size, page size, and one lowercase hex sha256 per page; the last page may be short. */
export interface LeaseManifest {
	size: number;
	pageSize: number;
	hashes: string[];
}

/** peek found pages that are not resident. */
export class PageAbsent extends Error {
	readonly pages: readonly number[];

	constructor(pages: readonly number[]) {
		super(`lease pages not resident: ${pages.join(', ')}`);
		this.name = 'PageAbsent';
		this.pages = pages;
	}
}

/** a page failed its manifest hash on every attempt; nothing was inserted. */
export class LeaseMismatch extends Error {
	readonly page: number;

	constructor(page: number) {
		super(`lease page ${page} failed its hash`);
		this.name = 'LeaseMismatch';
		this.page = page;
	}
}

export interface LeaseOptions {
	manifest: LeaseManifest;
	/** the remote read; returns fewer bytes than asked only at the end of the object. */
	fetchRange(offset: number, length: number): Promise<Uint8Array>;
	/** lru budget in bytes, raised to one page when smaller. default 4 MiB. */
	residentBytes?: number;
	/** refetches of a page whose bytes failed verification. default 1. */
	retries?: number;
}

export interface LeaseStats {
	hits: number;
	misses: number;
	fetches: number;
	fetchedBytes: number;
	mismatches: number;
	evictions: number;
	residentBytes: number;
}

/** paged read-through cache over a remote immutable object; every page is verified. */
export class Lease {
	readonly #options: LeaseOptions;
	readonly #manifest: LeaseManifest;
	readonly #budget: number;
	readonly #retries: number;
	// insertion order is recency order, oldest first
	readonly #resident = new Map<number, Uint8Array>();
	readonly #pins = new Map<number, number>();
	readonly #inflight = new Map<number, Promise<Uint8Array>>();
	readonly #waiting: (() => void)[] = [];
	// a page another read is fetching counts as a miss
	readonly #stats: LeaseStats = {
		hits: 0,
		misses: 0,
		fetches: 0,
		fetchedBytes: 0,
		mismatches: 0,
		evictions: 0,
		residentBytes: 0
	};

	constructor(options: LeaseOptions) {
		const { size, pageSize, hashes } = options.manifest;
		if (
			!Number.isSafeInteger(size) ||
			size < 0 ||
			!Number.isSafeInteger(pageSize) ||
			pageSize < 1 ||
			hashes.length !== Math.ceil(size / pageSize)
		) {
			throw new RangeError('lease manifest hashes do not cover its size');
		}
		this.#options = options;
		this.#manifest = options.manifest;
		this.#budget = Math.max(options.residentBytes ?? 4 * 2 ** 20, pageSize);
		this.#retries = options.retries ?? 1;
	}

	get stats(): LeaseStats {
		return { ...this.#stats };
	}

	peek(offset: number, length: number): Uint8Array {
		this.#check(offset, length);
		if (length === 0) return new Uint8Array(0);
		const first = this.#pageOf(offset);
		const last = this.#pageOf(offset + length - 1);
		const pages: Uint8Array[] = [];
		const absent: number[] = [];
		for (let page = first; page <= last; page++) {
			const bytes = this.#resident.get(page);
			if (bytes) {
				this.#hit(page, bytes);
				pages.push(bytes);
			} else {
				this.#stats.misses++;
				absent.push(page);
			}
		}
		if (absent.length) throw new PageAbsent(absent);
		return this.#assemble(offset, length, first, pages);
	}

	async read(offset: number, length: number): Promise<Uint8Array> {
		this.#check(offset, length);
		if (length === 0) return new Uint8Array(0);
		const first = this.#pageOf(offset);
		const pages = await this.#gather(first, this.#pageOf(offset + length - 1));
		return this.#assemble(offset, length, first, pages);
	}

	async prefetch(offset: number, length: number): Promise<void> {
		this.#check(offset, length);
		if (length === 0) return;
		await this.#gather(this.#pageOf(offset), this.#pageOf(offset + length - 1));
	}

	// pins the range once the pages it newly pins fit beside the pinned ones, or it runs alone
	async #turn(first: number, last: number): Promise<void> {
		for (;;) {
			let pinned = 0;
			for (const page of this.#pins.keys()) pinned += this.#pageLength(page);
			let need = 0;
			for (let page = first; page <= last; page++)
				if (!this.#pins.has(page)) need += this.#pageLength(page);
			if (pinned === 0 || pinned + need <= this.#budget) {
				this.#pin(first, last, 1);
				return;
			}
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		}
	}

	// a pinned page is never evicted while a read still needs it
	async #gather(first: number, last: number): Promise<Uint8Array[]> {
		await this.#turn(first, last);
		try {
			const parts = await Promise.all(this.#claim(first, last));
			// digests finish in any order; recency follows page order so the tail of a range stays
			for (let page = first; page <= last; page++) {
				const bytes = this.#resident.get(page);
				if (!bytes) continue;
				this.#resident.delete(page);
				this.#resident.set(page, bytes);
			}
			return parts;
		} finally {
			this.#pin(first, last, -1);
			this.#evict();
			for (const wake of this.#waiting.splice(0)) wake();
		}
	}

	// starts one fetch per run of adjacent missing pages and returns a promise per page
	#claim(first: number, last: number): Promise<Uint8Array>[] {
		const missing: number[] = [];
		for (let page = first; page <= last; page++) {
			const bytes = this.#resident.get(page);
			if (bytes) {
				this.#hit(page, bytes);
			} else {
				this.#stats.misses++;
				if (!this.#inflight.has(page)) missing.push(page);
			}
		}
		for (let i = 0; i < missing.length; i++) {
			let end = i;
			while (end + 1 < missing.length && missing[end + 1] === missing[end]! + 1) end++;
			this.#fetch(missing[i]!, missing[end]!);
			i = end;
		}
		const parts: Promise<Uint8Array>[] = [];
		for (let page = first; page <= last; page++) {
			const bytes = this.#resident.get(page);
			parts.push(bytes ? Promise.resolve(bytes) : this.#inflight.get(page)!);
		}
		return parts;
	}

	#fetch(first: number, last: number): void {
		const { pageSize, size } = this.#manifest;
		const offset = first * pageSize;
		const source = this.#transfer(offset, Math.min((last + 1) * pageSize, size) - offset);
		for (let page = first; page <= last; page++) {
			this.#inflight.set(page, this.#admit(page, first, source));
		}
	}

	async #transfer(offset: number, length: number): Promise<Uint8Array> {
		this.#stats.fetches++;
		const bytes = await this.#options.fetchRange(offset, length);
		this.#stats.fetchedBytes += bytes.length;
		return bytes;
	}

	// source holds bytes from page first onward; a retry replaces it with the one page
	async #admit(page: number, first: number, source: Promise<Uint8Array>): Promise<Uint8Array> {
		const { pageSize } = this.#manifest;
		const length = this.#pageLength(page);
		try {
			let origin = first * pageSize;
			let bytes = await source;
			for (let attempt = 0; ; attempt++) {
				const start = page * pageSize - origin;
				const copy = bytes.slice(start, start + length);
				if (
					copy.length === length &&
					(await digest(copy)) === this.#manifest.hashes[page]
				) {
					this.#insert(page, copy);
					return copy;
				}
				this.#stats.mismatches++;
				if (attempt >= this.#retries) throw new LeaseMismatch(page);
				origin = page * pageSize;
				bytes = await this.#transfer(origin, length);
			}
		} finally {
			this.#inflight.delete(page);
		}
	}

	#insert(page: number, bytes: Uint8Array): void {
		this.#resident.set(page, bytes);
		this.#stats.residentBytes += bytes.length;
		this.#evict();
	}

	#hit(page: number, bytes: Uint8Array): void {
		this.#stats.hits++;
		this.#resident.delete(page);
		this.#resident.set(page, bytes);
	}

	#evict(): void {
		for (const [page, bytes] of this.#resident) {
			if (this.#stats.residentBytes <= this.#budget) return;
			if (this.#pins.has(page)) continue;
			this.#resident.delete(page);
			this.#stats.residentBytes -= bytes.length;
			this.#stats.evictions++;
		}
	}

	#pin(first: number, last: number, delta: 1 | -1): void {
		for (let page = first; page <= last; page++) {
			const count = (this.#pins.get(page) ?? 0) + delta;
			if (count) this.#pins.set(page, count);
			else this.#pins.delete(page);
		}
	}

	#assemble(offset: number, length: number, first: number, pages: Uint8Array[]): Uint8Array {
		const { pageSize } = this.#manifest;
		const out = new Uint8Array(length);
		pages.forEach((bytes, i) => {
			const start = (first + i) * pageSize;
			const from = Math.max(offset - start, 0);
			const to = Math.min(offset + length - start, bytes.length);
			out.set(bytes.subarray(from, to), start + from - offset);
		});
		return out;
	}

	#pageOf(byte: number): number {
		return Math.floor(byte / this.#manifest.pageSize);
	}

	#pageLength(page: number): number {
		const { pageSize, size } = this.#manifest;
		return Math.min(pageSize, size - page * pageSize);
	}

	#check(offset: number, length: number): void {
		const { size } = this.#manifest;
		if (
			!Number.isSafeInteger(offset) ||
			!Number.isSafeInteger(length) ||
			offset < 0 ||
			length < 0 ||
			offset + length > size
		) {
			throw new RangeError(`lease range ${offset}+${length} is outside 0..${size}`);
		}
	}
}

/** producer side: pages of bytes and their hashes; the last page may be short. */
export async function buildManifest(bytes: Uint8Array, pageSize: number): Promise<LeaseManifest> {
	if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
		throw new RangeError(`page size ${pageSize} is not a positive integer`);
	}
	const hashes: string[] = [];
	for (let at = 0; at < bytes.length; at += pageSize) {
		hashes.push(await digest(bytes.subarray(at, at + pageSize)));
	}
	return { size: bytes.length, pageSize, hashes };
}

async function digest(bytes: Uint8Array): Promise<string> {
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
