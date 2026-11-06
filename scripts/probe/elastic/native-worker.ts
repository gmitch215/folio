import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

const { module, pages, backing, overlay, dirty, expected } = workerData;
const PAGE = 65536;
const memory = new WebAssembly.Memory({ initial: pages + 1, maximum: 65536, shared: true });
const file = await open(backing, 'r');
for (let page = 0; page < pages; page++) {
	const data = new Uint8Array(memory.buffer, (page + 1) * PAGE, PAGE);
	assert.equal((await file.read(data, 0, PAGE, page * PAGE)).bytesRead, PAGE);
}
const instance = new WebAssembly.Instance(module, { env: { memory } }).exports as Record<
	string,
	Function
>;
const actual = instance.walk!(pages, 1024) >>> 0;
assert.equal(actual, expected);
const hash = createHash('sha256'),
	compare = Buffer.alloc(PAGE),
	dirtySet = new Set(dirty);
for (let page = 0; page < pages; page++) {
	const data = new Uint8Array(memory.buffer, (page + 1) * PAGE, PAGE);
	const oracle = dirtySet.has(page) ? await readFile(`${overlay}/page-${page}`) : compare;
	if (!dirtySet.has(page))
		assert.equal((await file.read(compare, 0, PAGE, page * PAGE)).bytesRead, PAGE);
	assert.equal(Buffer.compare(data, oracle), 0, `native vs elastic page ${page}`);
	hash.update(data);
}
await file.close();
parentPort!.postMessage({
	actual,
	expected,
	exact: true,
	comparedPages: pages,
	comparedBytes: pages * PAGE,
	sha256: hash.digest('hex')
});
