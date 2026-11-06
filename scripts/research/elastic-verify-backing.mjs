import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const study = resolve(
	process.env.FOLIO_ELASTIC_STUDY ?? 'results/execution/elastic-memory/capacity-local'
);
const rows = [];
for (const name of ['raw.json', 'full-scan.json', 'read-only.json']) {
	if (!existsSync(join(study, name))) continue;
	const record = JSON.parse(await readFile(join(study, name), 'utf8'));
	const file = join(record.directory, 'pages.bin');
	const info = await stat(file);
	assert.equal(info.size, record.backingBytes);
	const hash = createHash('sha256');
	let pages = 0;
	for await (const bytes of createReadStream(file, { highWaterMark: 65536 })) {
		assert.equal(bytes.length, 65536);
		const iv = Buffer.alloc(16);
		iv.writeUInt32LE(pages);
		const expected = createCipheriv('aes-128-ctr', Buffer.alloc(16, 31), iv).update(
			Buffer.alloc(65536)
		);
		assert.ok(bytes.equals(expected), `${name}, page ${pages}`);
		hash.update(bytes);
		pages++;
	}
	const sha256 = hash.digest('hex');
	assert.equal(sha256, record.backingSha256);
	assert.equal(pages, 32768);
	rows.push({
		artifact: name,
		bytesVerified: info.size,
		pagesVerified: pages,
		allocatedFileBlocks512Bytes: info.blocks,
		sha256,
		exact: true
	});
}
await writeFile(join(study, 'backing-verification.json'), JSON.stringify({ rows }, null, 2) + '\n');
console.log(JSON.stringify(rows, null, 2));
