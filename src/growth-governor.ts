export interface GrowthGovernorOptions {
	capBytes: number;
	onRefuse?: (info: { fromBytes: number; toBytes: number }) => void;
}

export interface GrowthGovernor {
	refused: number;
	restore(): void;
}

const PAGE_BYTES = 65536;

/**
 * Refuses any memory.grow whose final size would exceed capBytes. Governors stack: a later one
 * calls the one it replaced, so both caps hold, and restore() must run in reverse install order.
 */
export function governGrowth(
	memory: WebAssembly.Memory,
	options: GrowthGovernorOptions
): GrowthGovernor {
	const { capBytes, onRefuse } = options;
	if (!Number.isInteger(capBytes) || capBytes <= 0) {
		throw new RangeError(`capBytes must be a finite positive integer, got ${capBytes}`);
	}

	const inner = memory.grow;
	const previous = Object.getOwnPropertyDescriptor(memory, 'grow');
	let installed = true;

	const governor: GrowthGovernor = {
		refused: 0,
		restore() {
			if (!installed) return;
			if (Object.getOwnPropertyDescriptor(memory, 'grow')?.value !== grow) {
				throw new Error('growth governors must be restored in reverse install order');
			}
			if (previous) Object.defineProperty(memory, 'grow', previous);
			else delete (memory as { grow?: unknown }).grow;
			installed = false;
		}
	};

	function grow(pages: number): number {
		const fromBytes = memory.buffer.byteLength;
		// emscripten passes fractional pages; native grow truncates them, so the target must too
		const toBytes = fromBytes + Math.trunc(pages) * PAGE_BYTES;
		if (toBytes > capBytes) {
			governor.refused += 1;
			onRefuse?.({ fromBytes, toBytes });
			throw new RangeError(
				`memory.grow to ${toBytes} bytes exceeds the ${capBytes} byte cap`
			);
		}
		return inner.call(memory, pages);
	}

	Object.defineProperty(memory, 'grow', { value: grow, configurable: true, writable: true });
	return governor;
}
