export type Access = { kind: 'load' | 'store' | 'fill'; page: number };

// the page a control touches at iteration i; the receiver's working set applies from the handoff on
export function touchedPage(
	i: number,
	iterations: number,
	working: number,
	receiver: number,
	pages: number
) {
	const width = i < Math.floor(iterations / 2) ? working : receiver;
	return (i % width) * Math.floor(pages / width);
}

// the word at offset 128 of a backing page; the sweep writes this into its backing file
export function backingWord(page: number) {
	return Math.imul(page + 1, 0x9e3779b1) | 0;
}

function mulberry32(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// page rank k (1-based) is page k - 1, so the hottest page is page 0
export function zipfTrace(options: {
	pages: number;
	length: number;
	s: number;
	readShare: number;
	seed: number;
}): Access[] {
	const { pages, length, s, readShare, seed } = options;
	const cumulative = new Float64Array(pages);
	let total = 0;
	for (let rank = 1; rank <= pages; rank++) {
		total += 1 / rank ** s;
		cumulative[rank - 1] = total;
	}
	const random = mulberry32(seed);
	const trace: Access[] = [];
	for (let n = 0; n < length; n++) {
		const target = random() * total;
		let low = 0;
		let high = pages - 1;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (cumulative[mid]! < target) low = mid + 1;
			else high = mid;
		}
		trace.push({ kind: random() < readShare ? 'load' : 'store', page: low });
	}
	return trace;
}

export function scanTrace(pages: number, passes: number): Access[] {
	const trace: Access[] = [];
	for (let pass = 0; pass < passes; pass++) {
		for (let page = 0; page < pages; page++) trace.push({ kind: 'load', page });
	}
	return trace;
}

// the first slot wins a tie, so an empty slot (stamp 0) is chosen before any used one
export function lruVictim(stamps: ArrayLike<number>) {
	let victim = 0;
	for (let slot = 1; slot < stamps.length; slot++) {
		if (stamps[slot]! < stamps[victim]!) victim = slot;
	}
	return victim;
}

// distinct pages touched since the previous access to the same page; -1 for a first access
export function stackDistances(trace: readonly Access[]) {
	const stack: number[] = [];
	return trace.map(({ page }) => {
		const at = stack.lastIndexOf(page);
		const distance = at >= 0 ? stack.length - 1 - at : -1;
		if (at >= 0) stack.splice(at, 1);
		stack.push(page);
		return distance;
	});
}

// the checksum a correct executor returns: each load mixes in the word last stored to its page
export function replayChecksum(trace: readonly Access[]) {
	const words = new Map<number, number>();
	let sum = 0;
	trace.forEach(({ kind, page }, i) => {
		if (kind === 'load')
			sum = (Math.imul(sum, 31) ^ (words.get(page) ?? backingWord(page))) | 0;
		else words.set(page, i);
	});
	return sum;
}
