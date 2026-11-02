import { createCipheriv } from 'node:crypto';
import { workerData } from 'node:worker_threads';
import { crc32 } from 'node:zlib';
import { serveTasks, type TaskLink } from '../../src/tasks.ts';

const { link, key } = workerData as { link: TaskLink; key: Buffer };

function adler(bytes: Buffer): number {
	let s1 = 1;
	let s2 = 0;
	for (const byte of bytes) {
		s1 = (s1 + byte) % 65521;
		s2 = (s2 + s1) % 65521;
	}
	return ((s2 << 16) | s1) >>> 0;
}

serveTasks(link, (name, input) => {
	const bytes = Buffer.from(input as Uint8Array);
	if (name === 'crc32') {
		const value = crc32(bytes) >>> 0;
		return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
	}
	if (name === 'adler32') {
		const value = adler(bytes);
		return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
	}
	if (name.startsWith('ctr:')) {
		const cipher = createCipheriv('aes-128-ctr', key, Buffer.from(name.slice(4), 'hex'));
		return new Uint8Array(cipher.update(bytes));
	}
	throw new Error(`unknown task ${name}`);
});
