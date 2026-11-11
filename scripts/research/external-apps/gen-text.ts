import { writeFileSync } from 'node:fs';

// usage: gen-text.ts OUT BYTES
// text-like and compressible: words from a 512-word table, newline every 12 words, xorshift32 seed 20261111

export function generateText(bytes: number): Uint8Array {
	let state = 20261111;
	const next = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state;
	};
	const letters = 'abcdefghijklmnopqrstuvwxyz';
	const words: string[] = [];
	for (let i = 0; i < 512; i++) {
		let word = '';
		const length = 2 + (next() % 9);
		for (let j = 0; j < length; j++) word += letters[next() % 26];
		words.push(word);
	}
	const out = new Uint8Array(bytes);
	let at = 0;
	let count = 0;
	while (at < bytes) {
		const word = words[next() % 512]!;
		for (let i = 0; i < word.length && at < bytes; i++) out[at++] = word.charCodeAt(i);
		if (at < bytes) out[at++] = ++count % 12 === 0 ? 10 : 32;
	}
	return out;
}

if (import.meta.main) {
	const [out, bytes] = process.argv.slice(2);
	if (!out || !bytes) throw new Error('usage: gen-text.ts OUT BYTES');
	writeFileSync(out, generateText(Number(bytes)));
}
