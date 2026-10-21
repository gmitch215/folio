import * as real from 'fflate-real';

const stats = ((globalThis as any).__inflate ??= { ms: 0, calls: 0, bytes: 0 });

export const inflateSync = (data: Uint8Array, opts?: { out?: Uint8Array }) => {
	const start = performance.now();
	const out = real.inflateSync(data, opts as any);
	stats.ms += performance.now() - start;
	stats.calls++;
	stats.bytes += out.length;
	return out;
};
