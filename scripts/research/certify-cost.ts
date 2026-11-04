import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
	foldCertified,
	installPrefill,
	reconstructCertified,
	shareCertified
} from '../../src/certified.ts';
import { certifyStream, type StreamCertificate } from '../../src/certify.ts';
import { TaskPool } from '../../src/tasks.ts';

// what it costs to make one artifact usable on the certified route, and what each call then saves
// usage: certify-cost.ts MODULE.wasm ENTRY OUTPUT.json
// FOLIO_WIDTH sets the workers (default 8), FOLIO_MIB the input size (default 8), FOLIO_ROUNDS the samples (default 7)
const [path, entry, output] = process.argv.slice(2);
if (!path || !entry || !output)
	throw new Error('usage: certify-cost.ts MODULE.wasm ENTRY OUTPUT.json');
if (existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
const subject = basename(path, '.wasm');
const width = Number(process.env.FOLIO_WIDTH ?? 8);
const mib = Number(process.env.FOLIO_MIB ?? 8);
const rounds = Number(process.env.FOLIO_ROUNDS ?? 7);
const original = new Uint8Array(readFileSync(path));

const lap = (since: number) => Number((performance.now() - since).toFixed(3));
const samples = (count: number, body: () => void) =>
	Array.from({ length: count }, () => {
		const t = performance.now();
		body();
		return lap(t);
	});

// certification is deterministic and cached by digest, so each sample is a cold run of the checker
const certifyMs = samples(5, () => {
	const r = certifyStream(original, entry);
	if (r.kind !== 'certificate') throw new Error(r.reason);
});
const certificate = certifyStream(original, entry) as StreamCertificate;

const at = 1 << 20;
const pages = at / 65536 + mib * 16 + 8;
let t = performance.now();
const prepared = shareCertified(original, certificate, pages);
const prepareMs = lap(t);
t = performance.now();
const module = new WebAssembly.Module(prepared.bytes);
const compileMs = lap(t);
const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
installPrefill(prepared, memory);
const input = new Uint8Array(memory.buffer, at, mib * 1048576);
for (let k = 0; k < input.length; k++) input[k] = (Math.imul(k, 17) ^ (k >>> 7)) & 255;

t = performance.now();
const pool = new TaskPool(width);
const workers = Array.from({ length: width }, (_, index) => {
	const link = pool.link(index);
	return new Worker(new URL('./certified-worker.ts', import.meta.url), {
		workerData: { module, memory, link, layout: certificate.layout },
		transferList: [link.port]
	});
});
// a kernel that rewrites its input runs through the reconstruction route, and its bytes are compared too
const fold = certificate.output ? reconstructCertified : foldCertified;
const pristine = certificate.output ? Uint8Array.from(input) : undefined;
const first = fold(pool, input, memory, certificate).state;
const firstCallMs = lap(t);
const folded = pristine && Uint8Array.from(input);
// CPU time of the whole process per call, workers included
const cpuPerCall = (body: () => void) => {
	const before = process.cpuUsage();
	body();
	const used = process.cpuUsage(before);
	return Number(((used.user + used.system) / 1000 / rounds).toFixed(3));
};
let steadyMs: number[] = [];
const cpuSteadyMs = cpuPerCall(() => {
	steadyMs = samples(rounds, () => {
		fold(pool, input, memory, certificate);
	});
});

const serial = new WebAssembly.Instance(module, { env: { memory } }).exports[entry] as (
	...args: (number | bigint)[]
) => number | bigint;
const { layout } = certificate;
const call = () => {
	const args: (number | bigint)[] = [0, 0, 0];
	args[layout.state] = layout.bits === 32 ? 0 : 0n;
	args[layout.ptr] = at;
	args[layout.len] = input.length;
	return BigInt.asUintN(layout.bits, BigInt(serial(...args)));
};
if (pristine) input.set(pristine);
const expected = call();
if (expected !== first) throw new Error('the certified fold differs from the serial call');
if (folded && !Buffer.from(input).equals(folded))
	throw new Error('the reconstructed bytes differ from the serial call');
let serialMs: number[] = [];
const cpuSerialMs = cpuPerCall(() => {
	serialMs = samples(rounds, call);
});
pool.close();
await Promise.all(workers.map((w) => w.terminate()));

const record = {
	kind: 'certified-route-cost',
	node: process.version,
	subject,
	width,
	mib,
	ring: certificate.ring,
	stats: certificate.stats,
	certifyMs,
	prepareMs,
	compileMs,
	firstCallMs,
	steadyMs,
	serialMs,
	cpuSteadyMs,
	cpuSerialMs
};
writeFileSync(output, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record));
