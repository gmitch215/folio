/** A WebAssembly page contains 64 KiB. */
export const pageBytes = 65536;

/** Every owner operation is scoped to one tenant, session and fresh directory incarnation. */
export interface PageScope {
	tenant: string;
	session: string;
	incarnation: string;
}

/** Immutable owner version. A fence is never reused within an incarnation. */
export interface PageVersion {
	page: number;
	fence: number;
}

/**
 * Transport boundary for immutable pages. Reads return independent copies. Staging is idempotent for
 * identical versions and bytes; discarding fences that version against delayed stage requests.
 * Implementations must authenticate the scope and enforce their own storage, request and deadline
 * limits. A never-settling request retains its directory locks; expiry cannot cancel an RPC.
 */
export interface PageOwner {
	readonly id: string;
	read(scope: PageScope, version: PageVersion): Promise<Uint8Array>;
	stage(scope: PageScope, version: PageVersion, bytes: Uint8Array): Promise<void>;
	discard(scope: PageScope, version: PageVersion): Promise<void>;
}

function integer(value: number, minimum: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new RangeError(`invalid ${label}`);
	return value;
}

function identity(scope: PageScope): Readonly<PageScope> {
	for (const value of [scope.tenant, scope.session, scope.incarnation]) {
		if (typeof value !== 'string' || !value.length || value.length > 128)
			throw new TypeError('invalid page scope');
	}
	return Object.freeze({ ...scope });
}

function sameScope(a: PageScope, b: PageScope): boolean {
	return a.tenant === b.tenant && a.session === b.session && a.incarnation === b.incarnation;
}

function versionKey(version: PageVersion): string {
	integer(version.page, 0, 65535, 'page');
	integer(version.fence, 1, Number.MAX_SAFE_INTEGER, 'page fence');
	return `${version.page}/${version.fence}`;
}

/** Bounded, volatile reference owner. This class does not persist pages across process loss. */
export class MemoryPageOwner implements PageOwner {
	readonly id: string;
	readonly #scope: Readonly<PageScope>;
	readonly #maximum: number;
	readonly #versions = new Map<string, Uint8Array>();
	readonly #closed = new Map<number, number>();
	constructor(id: string, scope: PageScope, maximumBytes: number) {
		if (typeof id !== 'string' || !id.length || id.length > 128)
			throw new TypeError('invalid page owner id');
		this.id = id;
		this.#scope = identity(scope);
		this.#maximum = integer(maximumBytes, pageBytes, Number.MAX_SAFE_INTEGER, 'owner credit');
	}
	/** Bytes retained by immutable versions, including unpublished staged versions. */
	get bytes(): number {
		return this.#versions.size * pageBytes;
	}
	#check(scope: PageScope, version: PageVersion): string {
		if (!sameScope(this.#scope, scope)) throw new Error('page owner scope mismatch');
		return versionKey(version);
	}
	async read(scope: PageScope, version: PageVersion): Promise<Uint8Array> {
		const bytes = this.#versions.get(this.#check(scope, version));
		if (!bytes) throw new Error('materialized page is missing');
		return bytes.slice();
	}
	async stage(scope: PageScope, version: PageVersion, bytes: Uint8Array): Promise<void> {
		const key = this.#check(scope, version);
		if (bytes.length !== pageBytes) throw new RangeError('invalid page payload size');
		if (version.fence <= (this.#closed.get(version.page) ?? 0))
			throw new Error('page version was fenced by discard');
		const previous = this.#versions.get(key);
		if (previous) {
			if (bytes.some((value, index) => value !== previous[index]))
				throw new Error('page version retry changed bytes');
			return;
		}
		if (this.bytes + pageBytes > this.#maximum)
			throw new RangeError('page owner credit exhausted');
		this.#versions.set(key, bytes.slice());
	}
	async discard(scope: PageScope, version: PageVersion): Promise<void> {
		const key = this.#check(scope, version);
		this.#closed.set(
			version.page,
			Math.max(this.#closed.get(version.page) ?? 0, version.fence)
		);
		this.#versions.delete(key);
	}
}

interface Reference {
	owner: PageOwner;
	version: Readonly<PageVersion>;
}

interface LeaseRecord {
	lease: ResidentPageLease;
	pages: number[];
	writes: Set<number>;
	expires: number;
	busy: boolean;
}

const residentState = new WeakMap<
	ResidentPageLease,
	{
		views: Map<number, Uint8Array>;
		released: boolean;
	}
>();

/** Bounds apply to retained metadata, resident pages and commit snapshots, not caller-owned copies. */
export interface PageDirectoryOptions {
	/** Fresh incarnation for one trusted active directory; never reuse it after a restart. */
	scope: PageScope;
	owners: readonly PageOwner[];
	initialPages?: number;
	maximumPages?: number;
	maximumLeases?: number;
	maximumLeasePages?: number;
	maximumResidentPages?: number;
	maximumRetiredPages?: number;
	leaseMilliseconds?: number;
	clock?: () => number;
}

/**
 * Volatile manifest coordinator. Publication is atomic within this instance. Recovery requires a
 * persisted manifest and decision log; this constructor only creates a fresh zero-filled arena.
 * Exactly one trusted directory may issue fences for its scope. Restart with a new incarnation;
 * reusing an old scope is unsupported and can collide with old versions and delayed requests.
 */
export class PageDirectory {
	readonly scope: Readonly<PageScope>;
	readonly #owners: readonly PageOwner[];
	readonly #manifest: (Reference | null)[];
	readonly #maximumPages: number;
	readonly #maximumLeases: number;
	readonly #maximumLeasePages: number;
	readonly #maximumResidentPages: number;
	readonly #maximumRetiredPages: number;
	readonly #milliseconds: number;
	readonly #clock: () => number;
	readonly #leases = new Map<ResidentPageLease, LeaseRecord>();
	readonly #locks = new Map<number, Set<LeaseRecord>>();
	readonly #retired = new Map<string, Reference>();
	#fence = 0;
	#resident = 0;
	#retirementReservations = 0;
	constructor(options: PageDirectoryOptions) {
		this.scope = identity(options.scope);
		if (
			!options.owners.length ||
			options.owners.length > 65536 ||
			options.owners.some(
				(owner) => typeof owner.id !== 'string' || !owner.id.length || owner.id.length > 128
			) ||
			new Set(options.owners.map((owner) => owner.id)).size !== options.owners.length
		)
			throw new TypeError('page owners must have distinct ids');
		this.#owners = [...options.owners];
		this.#maximumPages = integer(options.maximumPages ?? 65536, 0, 65536, 'maximum pages');
		this.#maximumLeases = integer(options.maximumLeases ?? 64, 1, 65536, 'maximum leases');
		this.#maximumLeasePages = integer(
			options.maximumLeasePages ?? 256,
			1,
			65536,
			'lease pages'
		);
		this.#maximumResidentPages = integer(
			options.maximumResidentPages ?? 512,
			1,
			131072,
			'resident pages'
		);
		this.#maximumRetiredPages = integer(
			options.maximumRetiredPages ?? 1024,
			2,
			131072,
			'retired pages'
		);
		this.#milliseconds = integer(
			options.leaseMilliseconds ?? 30000,
			1,
			Number.MAX_SAFE_INTEGER,
			'lease duration'
		);
		this.#clock = options.clock ?? Date.now;
		this.#manifest = Array.from(
			{ length: integer(options.initialPages ?? 0, 0, this.#maximumPages, 'initial pages') },
			() => null
		);
	}
	/** Directory metadata only; page contents live at owners or in active leases. */
	get stats(): { pages: number; residentBytes: number; leases: number; retiredPages: number } {
		this.#expire();
		return {
			pages: this.#manifest.length,
			residentBytes: this.#resident * pageBytes,
			leases: this.#leases.size,
			retiredPages: this.#retired.size
		};
	}
	/** Declares new zero pages without allocating page payloads. Returns the previous page count. */
	grow(pages: number): number {
		integer(pages, 0, this.#maximumPages - this.#manifest.length, 'growth');
		const previous = this.#manifest.length;
		for (let i = 0; i < pages; i++) this.#manifest.push(null);
		return previous;
	}
	/** Returns immutable manifest metadata, never a page view. */
	inspect(page: number): { zero: boolean; owner: string; fence: number } {
		this.#page(page);
		const ref = this.#manifest[page];
		return { zero: ref === null, owner: this.#owner(page).id, fence: ref?.version.fence ?? 0 };
	}
	#page(page: number): void {
		integer(page, 0, this.#manifest.length - 1, 'page address');
	}
	#owner(page: number): PageOwner {
		return this.#owners[page % this.#owners.length]!;
	}
	#now(): number {
		const now = this.#clock();
		if (!Number.isFinite(now)) throw new Error('invalid page clock');
		return now;
	}
	#release(record: LeaseRecord): void {
		if (!this.#leases.delete(record.lease)) return;
		for (const page of record.pages) {
			const locks = this.#locks.get(page)!;
			locks.delete(record);
			if (!locks.size) this.#locks.delete(page);
		}
		this.#resident -= record.pages.length;
		const state = residentState.get(record.lease)!;
		state.released = true;
		state.views.clear();
	}
	#expire(): void {
		const now = this.#now();
		for (const record of this.#leases.values()) {
			if (!record.busy && record.expires <= now) this.#release(record);
		}
	}
	#record(lease: ResidentPageLease, busy = false): LeaseRecord {
		const record = this.#leases.get(lease);
		if (!record || !sameScope(lease.scope, this.scope)) throw new Error('stale page lease');
		if (!busy && record.busy) throw new Error('page lease has an active operation');
		if (record.expires <= this.#now()) throw new Error('page lease expired');
		return record;
	}
	/** Acquires every page or none. Reads share locks; writes exclude all other leases. */
	async acquire(request: {
		read?: readonly number[];
		write?: readonly number[];
	}): Promise<ResidentPageLease> {
		this.#expire();
		integer(request.read?.length ?? 0, 0, this.#maximumLeasePages, 'lease page count');
		integer(request.write?.length ?? 0, 0, this.#maximumLeasePages, 'lease page count');
		const writes = new Set(request.write ?? []),
			pages = [...new Set([...(request.read ?? []), ...writes])].sort((a, b) => a - b);
		integer(pages.length, 1, this.#maximumLeasePages, 'lease page count');
		for (const page of pages) {
			this.#page(page);
			for (const lock of this.#locks.get(page) ?? []) {
				if (writes.has(page) || lock.writes.has(page))
					throw new Error('page lease conflict');
			}
		}
		if (
			this.#leases.size >= this.#maximumLeases ||
			this.#resident + pages.length > this.#maximumResidentPages
		)
			throw new RangeError('page lease credit exhausted');
		if (this.#fence >= Number.MAX_SAFE_INTEGER) throw new RangeError('page fence exhausted');
		const fence = ++this.#fence,
			expires = this.#now() + this.#milliseconds;
		const lease = new ResidentPageLease(this, this.scope, fence, expires, pages, writes);
		const record: LeaseRecord = { lease, pages, writes, expires, busy: true };
		this.#leases.set(lease, record);
		this.#resident += pages.length;
		for (const page of pages) {
			const locks = this.#locks.get(page) ?? new Set<LeaseRecord>();
			locks.add(record);
			this.#locks.set(page, locks);
		}
		try {
			for (const page of pages) {
				const ref = this.#manifest[page];
				const bytes = ref
					? await ref.owner.read(this.scope, ref.version)
					: new Uint8Array(pageBytes);
				this.#record(lease, true);
				if (bytes.length !== pageBytes) throw new RangeError('invalid owner page payload');
				residentState.get(lease)!.views.set(page, bytes.slice());
			}
			record.busy = false;
			return lease;
		} catch (error) {
			this.#release(record);
			throw error;
		}
	}
	/** Releases local dirty pages without publishing them. */
	abort(lease: ResidentPageLease): void {
		const record = this.#leases.get(lease);
		if (!record) return;
		if (record.busy) throw new Error('page lease has an active operation');
		this.#release(record);
	}
	/** Stages all dirty pages, validates the fence again, then publishes one manifest decision. */
	async commit(lease: ResidentPageLease): Promise<void> {
		const record = this.#record(lease);
		const writes = [...record.writes];
		if (this.#resident + writes.length > this.#maximumResidentPages)
			throw new RangeError('page snapshot credit exhausted');
		if (
			this.#retired.size + this.#retirementReservations + 2 * writes.length >
			this.#maximumRetiredPages
		)
			throw new RangeError('page retirement credit exhausted');
		const staged = writes.map((page) => ({
			ref: { owner: this.#owner(page), version: Object.freeze({ page, fence: lease.fence }) },
			bytes: lease.view(page).slice()
		}));
		record.busy = true;
		this.#resident += writes.length;
		this.#retirementReservations += 2 * writes.length;
		let published = false;
		try {
			for (const { ref, bytes } of staged) {
				await ref.owner.stage(this.scope, ref.version, bytes);
				this.#record(lease, true);
			}
			this.#record(lease, true);
			// no await between the final validation and the entire manifest publication
			for (const { ref } of staged) {
				const previous = this.#manifest[ref.version.page];
				if (previous) this.#retire(previous);
				this.#manifest[ref.version.page] = ref;
			}
			published = true;
		} finally {
			if (!published) for (const { ref } of staged) this.#retire(ref);
			this.#resident -= writes.length;
			this.#retirementReservations -= 2 * writes.length;
			this.#release(record);
		}
	}
	#retire(ref: Reference): void {
		this.#retired.set(`${ref.owner.id}/${versionKey(ref.version)}`, ref);
	}
	/** Retries idempotent garbage deletion; failed owners retain credits and remain visible here. */
	async collect(): Promise<{ discarded: number; pending: number }> {
		let discarded = 0;
		for (const [key, ref] of [...this.#retired]) {
			try {
				await ref.owner.discard(this.scope, ref.version);
				if (this.#retired.get(key) === ref) this.#retired.delete(key);
				discarded++;
			} catch {
				// unavailable garbage stays charged until a later successful discard
			}
		}
		return { discarded, pending: this.#retired.size };
	}
}

/**
 * Resident copies for one bounded region. Escaped views cannot be physically revoked; after release
 * they are caller-owned and outside the directory's admission accounting. They never alias owners.
 */
export class ResidentPageLease {
	readonly scope: Readonly<PageScope>;
	readonly fence: number;
	readonly expiresAt: number;
	readonly pages: readonly number[];
	readonly writable: readonly number[];
	readonly #directory: PageDirectory;
	constructor(
		directory: PageDirectory,
		scope: PageScope,
		fence: number,
		expires: number,
		pages: number[],
		writes: Set<number>
	) {
		this.#directory = directory;
		this.scope = Object.freeze({ ...scope });
		this.fence = fence;
		this.expiresAt = expires;
		this.pages = Object.freeze([...pages]);
		this.writable = Object.freeze([...writes]);
		residentState.set(this, { views: new Map(), released: false });
		Object.freeze(this);
	}
	/** Returns the local region page. Read pages may be changed locally but are never written back. */
	view(page: number): Uint8Array {
		const state = residentState.get(this)!;
		if (state.released) throw new Error('page lease is released');
		const bytes = state.views.get(page);
		if (!bytes) throw new RangeError('page is not resident in this lease');
		return bytes;
	}
	/** Publishes writable pages together, or rejects with the previous manifest intact. */
	commit(): Promise<void> {
		return this.#directory.commit(this);
	}
	/** Drops resident dirty bytes without publication. */
	abort(): void {
		this.#directory.abort(this);
	}
}
