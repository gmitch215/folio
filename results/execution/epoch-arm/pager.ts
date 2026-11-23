import { MISS_ENTRY, TABLE_ENTRIES, TranslationMiss } from './elastic-translate-host.ts';

// a small pager for the fixtures: pages [firstPage, firstPage + pages) live in a pool of frames at
// poolPage and fault in on demand; pages below firstPage are resident and identity-mapped.
// 'dynamic' picks a free frame, then the oldest; 'fixed' maps page p to frame p - firstPage (no eviction
// when frames >= pages); 'split' maps neighbours to frames whose deltas differ.
export interface PagerOptions {
	tableBase: number;
	epochAddr: number;
	firstPage: number;
	pages: number;
	poolPage: number;
	frames: number;
	mode: 'dynamic' | 'fixed' | 'split';
}

const PAGE = 65536;

export class Pager {
	memory: WebAssembly.Memory;
	o: PagerOptions;
	backing = new Map<number, Uint8Array>();
	frameOf = new Map<number, number>();
	occupant: (number | null)[];
	fifo = 0;
	counts = { slow: 0, faults: 0, evictions: 0, straddles: 0 };

	constructor(memory: WebAssembly.Memory, o: PagerOptions) {
		this.memory = memory;
		this.o = o;
		this.occupant = new Array(o.frames).fill(null);
		const table = this.table();
		table.fill(MISS_ENTRY);
		table.fill(0, 0, o.firstPage);
	}

	table() {
		return new Int32Array(this.memory.buffer, this.o.tableBase, TABLE_ENTRIES);
	}

	epochWord() {
		return new Int32Array(this.memory.buffer, this.o.epochAddr, 1);
	}

	pageable(page: number) {
		return page >= this.o.firstPage && page < this.o.firstPage + this.o.pages;
	}

	// install the starting contents of a pageable page in the backing store
	seed(page: number, bytes: Uint8Array) {
		this.backing.set(page, bytes.slice());
	}

	frameAddr(frame: number) {
		return (this.o.poolPage + frame) * PAGE;
	}

	delta(page: number, frame: number) {
		return ((this.o.poolPage + frame - page) * PAGE) | 0;
	}

	pickFrame(page: number, protect: number) {
		if (this.o.mode === 'fixed') return page - this.o.firstPage;
		if (this.o.mode === 'split') return ((page - this.o.firstPage) * 3) % this.o.frames;
		const free = this.occupant.indexOf(null);
		if (free >= 0) return free;
		for (let k = 0; k < this.o.frames; k++) {
			const f = (this.fifo + k) % this.o.frames;
			if (this.occupant[f] !== protect) {
				this.fifo = (f + 1) % this.o.frames;
				return f;
			}
		}
		throw new Error('no frame to evict');
	}

	evict(frame: number) {
		const q = this.occupant[frame];
		if (q === null || q === undefined) return;
		const mem = new Uint8Array(this.memory.buffer);
		this.backing.set(q, mem.slice(this.frameAddr(frame), this.frameAddr(frame) + PAGE));
		this.table()[q] = MISS_ENTRY;
		this.frameOf.delete(q);
		this.occupant[frame] = null;
		this.epochWord()[0]++;
		this.counts.evictions++;
	}

	faultIn(page: number, address: number, bytes: number, protect = -1) {
		if (!this.pageable(page)) throw new TranslationMiss(address, bytes);
		this.counts.faults++;
		const frame = this.pickFrame(page, protect);
		this.evict(frame);
		const mem = new Uint8Array(this.memory.buffer);
		mem.set(this.backing.get(page) ?? new Uint8Array(PAGE), this.frameAddr(frame));
		this.occupant[frame] = page;
		this.frameOf.set(page, frame);
		this.table()[page] = this.delta(page, frame);
	}

	// the folio.slow import
	slow = (pointer: number, offset: number, bytes: number): number => {
		this.counts.slow++;
		const address = (pointer >>> 0) + offset;
		if (address > 0xffffffff) throw new TranslationMiss(address >>> 0, bytes, 'address wrap');
		const table = this.table();
		const first = address >>> 16;
		if (table[first] === MISS_ENTRY) this.faultIn(first, address, bytes);
		const entry = this.table()[first]!;
		const last = (address + bytes - 1) >>> 0;
		if (last >>> 16 === first) return entry;
		this.counts.straddles++;
		const next = first + 1;
		if (next >= TABLE_ENTRIES) throw new TranslationMiss((next << 16) >>> 0, bytes, 'page straddle');
		if (this.table()[next] === MISS_ENTRY && this.pageable(next))
			this.faultIn(next, (next << 16) >>> 0, bytes, first);
		// the second fault can only evict a page other than the first, so entry still holds
		if (this.table()[first] !== entry || this.table()[next] !== entry)
			throw new TranslationMiss((next << 16) >>> 0, bytes, 'page straddle');
		return entry;
	};

	stackMiss = (pointer: number) => {
		throw new TranslationMiss(pointer >>> 0, 0, 'stack window');
	};

	imports() {
		return { folio: { slow: this.slow, stack_miss: this.stackMiss } };
	}

	// current contents of any page, resident or not
	readPage(page: number): Uint8Array {
		const mem = new Uint8Array(this.memory.buffer);
		if (!this.pageable(page)) return mem.slice(page * PAGE, (page + 1) * PAGE);
		const frame = this.frameOf.get(page);
		if (frame !== undefined)
			return mem.slice(this.frameAddr(frame), this.frameAddr(frame) + PAGE);
		return (this.backing.get(page) ?? new Uint8Array(PAGE)).slice();
	}
}
