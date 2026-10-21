import binaryen from 'binaryen';
import assert from 'node:assert/strict';
import { MemoryPageOwner, PageDirectory, pageBytes, type PageOwner } from '../../src/pages.ts';

// explicit bounded spans, not transparent wasm paging or a deployment benchmark
const logicalPages = 128,
	materializedPages = 96,
	spanPages = 4;
const scope = { tenant: 'probe', session: 'leased-wasm', incarnation: crypto.randomUUID() };
const owners = Array.from(
	{ length: 4 },
	(_, index) => new MemoryPageOwner(`owner-${index}`, scope, 32 * pageBytes)
);
let directory: PageDirectory,
	peakResidentBytes = 0,
	peakOwnerBytes = 0;
const observe = () => {
	peakResidentBytes = Math.max(peakResidentBytes, directory.stats.residentBytes);
	peakOwnerBytes = Math.max(peakOwnerBytes, ...owners.map((owner) => owner.bytes));
};
const transports: PageOwner[] = owners.map((owner) => ({
	id: owner.id,
	read: (scope, version) => owner.read(scope, version),
	stage: async (scope, version, bytes) => {
		await owner.stage(scope, version, bytes);
		observe();
	},
	discard: (scope, version) => owner.discard(scope, version)
}));
directory = new PageDirectory({
	scope,
	owners: transports,
	initialPages: logicalPages,
	maximumResidentPages: 2 * spanPages,
	maximumLeasePages: spanPages,
	maximumRetiredPages: 2 * spanPages
});

const parsed = binaryen.parseText(`(module
 (import "env" "memory" (memory 1 128))
 (func (export "run") (param $base i32) (param $count i32) (result i32)
  (local $i i32) (local $sum i32) (local $value i32) (local $address i32)
  (block $exit (loop $again
   (br_if $exit (i32.ge_u (local.get $i) (local.get $count)))
   (local.set $address (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 2))))
   (local.set $value (i32.add
    (i32.mul (i32.load (local.get $address)) (i32.const 1664525))
    (i32.const 1013904223)))
   (i32.store (local.get $address) (local.get $value))
   (local.set $sum (i32.add (local.get $sum) (local.get $value)))
   (local.set $i (i32.add (local.get $i) (i32.const 1)))
   (br $again)))
  (local.get $sum)))`);
const bytes = parsed.emitBinary();
parsed.dispose();
const module = new WebAssembly.Module(Uint8Array.from(bytes));
const nativeMemory = new WebAssembly.Memory({ initial: logicalPages, maximum: logicalPages });
const regionMemory = new WebAssembly.Memory({ initial: spanPages, maximum: logicalPages });
const native = new WebAssembly.Instance(module, { env: { memory: nativeMemory } });
const region = new WebAssembly.Instance(module, { env: { memory: regionMemory } });
const nativeBytes = new Uint8Array(nativeMemory.buffer),
	regionBytes = new Uint8Array(regionMemory.buffer);
const words = new Uint32Array(nativeMemory.buffer);
for (let i = 0; i < (materializedPages * pageBytes) / 4; i++)
	words[i] = (i * 17 + 0x12345678) >>> 0;

for (let base = 0; base < materializedPages; base += spanPages) {
	const pages = Array.from({ length: spanPages }, (_, offset) => base + offset);
	const lease = await directory.acquire({ write: pages });
	for (const page of pages)
		lease.view(page).set(nativeBytes.subarray(page * pageBytes, (page + 1) * pageBytes));
	await lease.commit();
	assert.equal((await directory.collect()).pending, 0);
}
const expected = (native.exports.run as CallableFunction)(0, (materializedPages * pageBytes) / 4);
let sum = 0,
	regions = 0;
const started = performance.now();
for (let base = 0; base < materializedPages; base += spanPages) {
	const pages = Array.from({ length: spanPages }, (_, offset) => base + offset);
	const lease = await directory.acquire({ write: pages });
	for (let index = 0; index < pages.length; index++)
		regionBytes.set(lease.view(pages[index]!), index * pageBytes);
	sum = (sum + (region.exports.run as CallableFunction)(0, (spanPages * pageBytes) / 4)) | 0;
	for (let index = 0; index < pages.length; index++)
		lease
			.view(pages[index]!)
			.set(regionBytes.subarray(index * pageBytes, (index + 1) * pageBytes));
	await lease.commit();
	assert.equal((await directory.collect()).pending, 0);
	regions++;
}
const elapsedMs = performance.now() - started;
assert.equal(sum, expected);
for (let base = 0; base < logicalPages; base += spanPages) {
	const pages = Array.from({ length: spanPages }, (_, offset) => base + offset);
	const lease = await directory.acquire({ read: pages });
	for (const page of pages)
		assert.deepEqual(
			lease.view(page),
			nativeBytes.subarray(page * pageBytes, (page + 1) * pageBytes)
		);
	lease.abort();
}
assert.equal(directory.stats.leases, 0);
assert.equal(directory.stats.residentBytes, 0);
assert.equal(directory.stats.retiredPages, 0);
console.log(
	JSON.stringify(
		{
			kind: 'local-reference-owner-leased-native-wasm',
			node: process.version,
			logicalBytes: logicalPages * pageBytes,
			materializedBytes: owners.reduce((sum, owner) => sum + owner.bytes, 0),
			owners: owners.length,
			ownerCreditBytes: 32 * pageBytes,
			residentCreditBytes: 2 * spanPages * pageBytes,
			peakChargedResidentBytes: peakResidentBytes,
			peakOwnerBytes,
			regionWasmBytes: regionMemory.buffer.byteLength,
			regions,
			exactReturn: sum === expected,
			exactComparedBytes: nativeBytes.length,
			elapsedMs,
			final: directory.stats,
			limits: [
				'local reference owners, no remote latency measurement',
				'copied leases, not shared backing',
				'explicit spans, not arbitrary native-memory paging',
				'volatile manifest and owners, no crash recovery',
				'charged page credits are not RSS'
			]
		},
		null,
		2
	)
);
