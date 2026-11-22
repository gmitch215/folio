import { hashPages } from '../../src/memory/continuation.ts';

const RUNS = 5;
const rate = (mib: number, ms: number) => Number((mib / 1024 / (ms / 1000)).toFixed(3));
const sha256 = (bytes: Uint8Array<ArrayBuffer>) => crypto.subtle.digest('SHA-256', bytes);

for (const mib of [32, 128]) {
	const bytes = new Uint8Array(mib * 2 ** 20);
	for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i * 2654435761) >>> 24;
	hashPages(bytes);
	await sha256(bytes);
	for (let run = 1; run <= RUNS; run++) {
		let start = performance.now();
		hashPages(bytes);
		const hashPagesGiBs = rate(mib, performance.now() - start);
		// the control runs right after the JS pass on the same buffer
		start = performance.now();
		await sha256(bytes);
		const sha256GiBs = rate(mib, performance.now() - start);
		console.log(
			JSON.stringify({
				study: 'checkpoint-cost',
				kind: 'hash-bench',
				mib,
				run,
				hashPagesGiBs,
				sha256GiBs,
				nodeVersion: process.version
			})
		);
	}
}
