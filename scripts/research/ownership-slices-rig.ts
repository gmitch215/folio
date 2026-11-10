import { ownershipSlices, type OwnershipSlices } from '../../src/ownership-slices.ts';
import type { OwnershipCertificate } from '../../src/ownership.ts';
import type { OwnedSliceReport } from '../../src/slices.ts';

// shared by the slices gate and its timing: a pool over a certified module and the serial program to compare with
export const importsUrl = new URL('./ownership-slices-imports.ts', import.meta.url);

export interface SliceRig {
	pool: OwnershipSlices;
	memory: WebAssembly.Memory;
	original: WebAssembly.Module;
	pages: number;
}

export interface SliceCall {
	table: number;
	n: number;
	out: number;
	slot: number;
	regions: [number, number][];
}

export interface SliceRun {
	bytes: Uint8Array;
	error?: unknown;
	report?: OwnedSliceReport;
	wallMs?: number;
}

export async function openSliceRig(
	bytes: Uint8Array,
	certificate: OwnershipCertificate,
	pages: number,
	workers: number,
	maximum = 65536
): Promise<SliceRig> {
	const memory = new WebAssembly.Memory({ initial: pages, maximum, shared: true });
	const pool = await ownershipSlices(bytes, certificate, {
		memory,
		workers,
		imports: importsUrl
	});
	return {
		pool,
		memory,
		original: new WebAssembly.Module(Uint8Array.from(bytes)),
		pages
	};
}

export const closeSliceRig = (rig: SliceRig) => rig.pool.close();

// the serial program: the original module in place on a private memory
export function serialRun(
	rig: Pick<SliceRig, 'pages' | 'original'>,
	image: Uint8Array,
	call: SliceCall,
	imports: WebAssembly.ModuleImports
): SliceRun {
	const memory = new WebAssembly.Memory({ initial: rig.pages, maximum: rig.pages });
	new Uint8Array(memory.buffer).set(image.subarray(0, memory.buffer.byteLength));
	const instance = new WebAssembly.Instance(rig.original, { env: { memory, ...imports } });
	let error: unknown;
	try {
		(instance.exports.bulk as (...a: number[]) => unknown)(call.table, call.n, call.out);
	} catch (caught) {
		error = caught;
	}
	return { bytes: new Uint8Array(memory.buffer), error };
}

// the image after the module's data segments are applied over it, which is what the pool starts from
export function bootedImage(
	rig: Pick<SliceRig, 'pages' | 'original'>,
	image: Uint8Array,
	imports: WebAssembly.ModuleImports
): Uint8Array {
	const memory = new WebAssembly.Memory({ initial: rig.pages, maximum: rig.pages });
	new Uint8Array(memory.buffer).set(image.subarray(0, memory.buffer.byteLength));
	new WebAssembly.Instance(rig.original, { env: { memory, ...imports } });
	return new Uint8Array(memory.buffer).slice();
}

// puts the booted image into the memory, then runs the certified entry on the slices
export async function slicesRun(
	rig: SliceRig,
	booted: Uint8Array,
	call: SliceCall,
	options: { writes?: [number, number][]; grain?: number } = {}
): Promise<SliceRun> {
	const view = new Uint8Array(rig.memory.buffer);
	view.set(booted.subarray(0, rig.pages * 65536));
	let error: unknown;
	let report;
	try {
		report = await rig.pool.run(
			call.n,
			(from, to) => [call.table + 16 * from, to - from, call.out + call.slot * from],
			{
				regions: call.regions,
				writes: options.writes ?? [[call.out, call.out + call.n * call.slot]],
				grain: options.grain
			}
		);
	} catch (caught) {
		error = caught;
	}
	return {
		bytes: view.slice(0, rig.pages * 65536),
		error,
		report: report?.ownership,
		wallMs: report?.wallMs
	};
}

// first byte that differs at or above `from`, or -1
export function firstDifference(a: Uint8Array, b: Uint8Array, from: number): number {
	const end = Math.min(a.length, b.length);
	for (let i = from; i < end; i++) if (a[i] !== b[i]) return i;
	return a.length === b.length ? -1 : end;
}
