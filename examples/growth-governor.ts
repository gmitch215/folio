import { governGrowth } from '@gmitch215/folio/growth-governor';

// Cap an Emscripten-style guest at 8 MiB. The glue tries the current size times 1.2, 1.1 and 1.05,
// never below the request; the governor refuses every attempt that would pass the cap, so the
// guest gets the largest size that fits or a clean failure with its memory unchanged.
const PAGE = 65536;
const memory = new WebAssembly.Memory({ initial: 64, maximum: 4096 });
const governor = governGrowth(memory, {
	capBytes: 8 * 1024 * 1024,
	onRefuse: ({ fromBytes, toBytes }) => console.log('refused', { fromBytes, toBytes })
});

function resizeHeap(requestedBytes: number): boolean {
	const old = memory.buffer.byteLength;
	for (const overgrow of [1.2, 1.1, 1.05]) {
		const target = Math.max(requestedBytes, Math.trunc(old * overgrow));
		const pages = Math.ceil((target - old) / PAGE);
		try {
			memory.grow(pages);
			return true;
		} catch {
			// a refused attempt falls through to the smaller size
		}
	}
	return false;
}

console.log('grow to 6 MiB:', resizeHeap(6 * 1024 * 1024), memory.buffer.byteLength);
console.log('grow to 12 MiB:', resizeHeap(12 * 1024 * 1024), memory.buffer.byteLength);
console.log('refusals:', governor.refused);

governor.restore();
