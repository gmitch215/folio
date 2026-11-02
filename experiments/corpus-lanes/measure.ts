import { decodeFrame } from '../../src/frames.ts';
import type { ManagedLaneTransport } from '../../src/managed.ts';

/** `FolioLane` takes at most this many calls in one request; the owner flushes at width x this. */
export const callsPerRequest = 16;

/** Records that fit `budget` tracked byte addresses, scaled by `margin`. */
export function recordsPerRequest(trackedPerRecord: number, budget: number, margin = 1): number {
	if (!(trackedPerRecord > 0)) throw new RangeError('invalid tracked bytes per record');
	return Math.max(0, Math.floor((budget * margin) / trackedPerRecord));
}

/** Records one lane request may carry under the byte budget (per request) and the fuel (per call). */
export function recordsPerCall(o: {
	trackedPerRecord: number;
	budget: number;
	fuelPerRecord: number;
	fuel: number;
	margin?: number;
}): { bytes: number; fuel: number; calls: number } {
	const margin = o.margin ?? 0.8;
	const bytes = recordsPerRequest(o.trackedPerRecord, o.budget, margin);
	const fuel = Math.max(0, Math.floor((o.fuel * margin) / Math.max(1, o.fuelPerRecord)));
	return { bytes, fuel, calls: Math.min(bytes, fuel) };
}

/**
 * Records per lane request above which `width` overlapped lanes beat the serial run, or null when
 * a lane is slower per record than `width` serial cores, so that no batch size pays.
 */
export function breakEven(o: {
	serialMsPerRecord: number;
	laneMsPerRecord: number;
	fixedMsPerRequest: number;
	width: number;
}): number | null {
	const gain = o.width * o.serialMsPerRecord - o.laneMsPerRecord;
	if (gain <= 0) return null;
	return Math.ceil(o.fixedMsPerRequest / gain);
}

/** Least squares for y = a x + b z through the origin, for the fixed and the per-byte cost. */
export function fitTwo(points: { x: number; z: number; y: number }[]): { a: number; b: number } {
	let xx = 0,
		xz = 0,
		zz = 0,
		xy = 0,
		zy = 0;
	for (const { x, z, y } of points) {
		xx += x * x;
		xz += x * z;
		zz += z * z;
		xy += x * y;
		zy += z * y;
	}
	const det = xx * zz - xz * xz;
	if (!det) throw new RangeError('points are collinear');
	return { a: (xy * zz - zy * xz) / det, b: (zy * xx - xy * xz) / det };
}

/**
 * First measured call to a batch size: the tracked bytes per record, read from one probe's
 * response headers, set the records a call carries and the most records one run may enqueue
 * before the owner flushes. A record that alone exceeds the budget gives zero. Nothing here
 * changes a library default.
 */
export function sizeBatch(o: {
	trackedPerRecord: number;
	budget: number;
	fuelPerRecord: number;
	fuel: number;
	width: number;
	margin?: number;
}): { perCall: number; callsPerLaneRequest: number; perRun: number } {
	const limit = recordsPerCall(o);
	if (!limit.calls) return { perCall: 0, callsPerLaneRequest: 0, perRun: 0 };
	const perCall = Math.max(1, Math.min(Math.floor(limit.bytes / callsPerRequest), limit.fuel));
	const callsPerLaneRequest = Math.min(
		callsPerRequest,
		Math.max(1, Math.floor(limit.bytes / perCall))
	);
	return { perCall, callsPerLaneRequest, perRun: o.width * callsPerLaneRequest * perCall };
}

export interface Tally {
	requests: number;
	laneMs: number;
	calls: number;
	reads: number;
	writes: number;
	exhaustedCalls: number;
	escapeCalls: number;
	perRequest: { calls: number; ms: number; reads: number; writes: number }[];
}

export const emptyTally = (): Tally => ({
	requests: 0,
	laneMs: 0,
	calls: 0,
	reads: 0,
	writes: 0,
	exhaustedCalls: 0,
	escapeCalls: 0,
	perRequest: []
});

/** A transport that reports how long its lane ran, so queueing behind other lanes is not counted. */
export interface TimedTransport extends ManagedLaneTransport {
	lastMs?: number;
}

/** Wraps a transport and reads the per-call tracking counts out of every response header. */
export function measuring(inner: TimedTransport, tally: Tally): ManagedLaneTransport {
	return {
		execute: async (frame) => {
			const began = performance.now();
			const response = await inner.execute(frame);
			const ms = inner.lastMs ?? performance.now() - began;
			const { header } = decodeFrame<{
				results: {
					reads: number;
					writes: number;
					readBytes?: number;
					writeBytes?: number;
					exhausted?: boolean;
					escapes?: number;
				}[];
			}>(response, response.length);
			const row = { calls: header.results.length, ms, reads: 0, writes: 0 };
			for (const result of header.results) {
				row.reads += result.readBytes ?? result.reads;
				row.writes += result.writeBytes ?? result.writes;
				if (result.exhausted) tally.exhaustedCalls++;
				if (result.escapes) tally.escapeCalls++;
			}
			tally.requests++;
			tally.laneMs += ms;
			tally.calls += row.calls;
			tally.reads += row.reads;
			tally.writes += row.writes;
			tally.perRequest.push(row);
			return response;
		},
		close: inner.close?.bind(inner)
	};
}
