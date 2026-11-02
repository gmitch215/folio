import kernel from './build/kernel.wasm';

let run: ((rounds: number) => number) | undefined;
let isolate: string | undefined;
let calls = 0;

export const isolateId = () => (isolate ??= crypto.randomUUID());

// one call: the log line is how the driver finds this call's cpu and wall in the tail
export function spin(rounds: number, rid: number, slot: number, instance: string) {
	run ??= (new WebAssembly.Instance(kernel).exports as { run: (rounds: number) => number }).run;
	// the clock only moves on i/o, so this is when the platform delivered the call
	const entered = Date.now();
	const call = ++calls;
	console.log(JSON.stringify({ probe: 'concurrency-lane', rid, slot }));
	const checksum = run(rounds) >>> 0;
	return { isolate: isolateId(), instance, call, checksum, entered };
}

/** The data center that answered an outbound request from this isolate; null when unreachable. */
export async function colo() {
	try {
		const text = await (
			await fetch('https://workers.cloudflare.com/cdn-cgi/trace', {
				signal: AbortSignal.timeout(5000)
			})
		).text();
		return /^colo=(\w+)$/m.exec(text)?.[1] ?? null;
	} catch {
		return null;
	}
}

export const frontDoor = (request: Request) =>
	(request as unknown as { cf?: { colo?: string } }).cf?.colo ?? null;
