/**
 * Deterministic inputs per subject and kind. `random` is uniform bytes. `text` is valid input for
 * the subject's own format (UTF-8 text, quoted CSV rows, MIME base64, RLE pairs). `adv` is the
 * adversary: an unclosed quote, an overlong sequence at every boundary, a stream with no
 * resynchronising byte, or all zeros for the controls.
 */

export const kinds = ['random', 'text', 'adv'] as const;
export type Kind = (typeof kinds)[number];

/** The 32-way split boundaries, shifted as in `bounds`; the 8-way ones are a subset. */
const boundaries = (n: number) =>
	Array.from({ length: 31 }, (_, k) => Math.floor(((k + 1) * n) / 32) + 1);

function xorshift(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return s >>> 0;
	};
}

/** Appends bytes into a buffer of a known size; writes past the end are dropped. */
class Writer {
	readonly bytes: Uint8Array;
	at = 0;
	constructor(size: number) {
		this.bytes = new Uint8Array(size);
	}
	put(byte: number) {
		if (this.at < this.bytes.length) this.bytes[this.at++] = byte;
	}
	room() {
		return this.bytes.length - this.at;
	}
	text(s: string) {
		for (let i = 0; i < s.length && this.room() > 0; i++) this.put(s.charCodeAt(i));
	}
}

const words = [
	'the',
	'quick',
	'brown',
	'fox',
	'jumps',
	'over',
	'lazy',
	'dog',
	'river',
	'lamp',
	'stone',
	'paper',
	'window',
	'garden',
	'signal',
	'folio',
	'memory',
	'lane',
	'chunk',
	'state',
	'table',
	'value'
];
// multibyte code points: U+00E9, U+20AC, U+1F600 and U+4E2D
const multibyte = [
	[0xc3, 0xa9],
	[0xe2, 0x82, 0xac],
	[0xf0, 0x9f, 0x98, 0x80],
	[0xe4, 0xb8, 0xad]
];

/** Valid UTF-8 prose with newlines. Never writes a quote character. */
function prose(n: number, seed: number, newlines = true): Uint8Array {
	const rnd = xorshift(seed);
	const w = new Writer(n);
	let column = 0;
	while (w.room() > 0) {
		if (w.room() < 4) {
			w.put(0x20);
			continue;
		}
		const r = rnd() % 100;
		if (r < 3) {
			for (const b of multibyte[rnd() % multibyte.length]!) w.put(b);
			column += 2;
		} else {
			w.text(words[rnd() % words.length]!);
			column += 6;
			w.put(rnd() % 9 === 0 ? 0x2c : 0x20);
		}
		if (newlines && column > 60 && rnd() % 4 === 0) {
			w.put(0x0a);
			column = 0;
		}
	}
	return w.bytes;
}

function randomBytes(n: number, seed: number): Uint8Array {
	const rnd = xorshift(seed);
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i += 4) {
		const v = rnd();
		for (let k = 0; k < 4 && i + k < n; k++) out[i + k] = (v >>> (8 * k)) & 0xff;
	}
	return out;
}

/** Quoted CSV rows, every quote balanced at a row end; fields hold commas, newlines and "". */
function csv(n: number, seed: number): Uint8Array {
	const rnd = xorshift(seed);
	const w = new Writer(n);
	while (w.room() > 0) {
		const fields = 2 + (rnd() % 4);
		for (let f = 0; f < fields; f++) {
			if (f) w.put(0x2c);
			if (rnd() % 2) {
				w.put(0x22);
				const parts = 1 + (rnd() % 4);
				for (let p = 0; p < parts; p++) {
					w.text(words[rnd() % words.length]!);
					if (rnd() % 5 === 0) w.text(',');
					if (rnd() % 7 === 0) w.text('\n');
					if (rnd() % 9 === 0) w.text('""');
					w.put(0x20);
				}
				w.put(0x22);
			} else {
				w.text(words[rnd() % words.length]!);
			}
		}
		w.put(0x0a);
	}
	return w.bytes;
}

const b64 = new TextEncoder();
const alphabet = b64.encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');

/** MIME base64 of prose: lines of 76 characters, padding only at the end of the whole encoding. */
function mime(n: number, seed: number): Uint8Array {
	const raw = Buffer.from(prose(Math.ceil((n * 3) / 4) + 16, seed, true)).toString('base64');
	const w = new Writer(n);
	let column = 0;
	for (let i = 0; w.room() > 0 && i < raw.length; i++) {
		if (column === 76) {
			w.put(0x0a);
			column = 0;
			continue;
		}
		w.put(raw.charCodeAt(i));
		column++;
	}
	return w.bytes;
}

/** RLE pairs: a count in 1 to 127 (or 1 for the adversary), then printable text. */
function rle(n: number, seed: number, counts: (rnd: () => number) => number): Uint8Array {
	const rnd = xorshift(seed);
	const text = prose(n, seed ^ 0x5bd1e995, false);
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i += 2) {
		out[i] = counts(rnd);
		if (i + 1 < n) out[i + 1] = 0x20 + ((text[i] ?? 0) % 95);
	}
	return out;
}

/** Valid UTF-8 prose with an overlong E0 80 80 straddling every boundary of the 32-way split. */
function overlong(n: number, seed: number): Uint8Array {
	const out = prose(n, seed);
	for (const b of boundaries(n)) {
		if (b - 1 < 0 || b + 1 >= n) continue;
		out[b - 1] = 0xe0;
		out[b] = 0x80;
		out[b + 1] = 0x80;
	}
	return out;
}

/** Prose with every fifth space a tab, so the tab parity is not constant. */
function tabbed(n: number, seed: number, newlines: boolean): Uint8Array {
	const out = prose(n, seed, newlines);
	for (let i = 0; i < n; i += 5) if (out[i] === 0x20) out[i] = 0x09;
	return out;
}

/** Valid base64 characters only: no newline, no padding. The phase counter never resets. */
function alphabetOnly(n: number, seed: number): Uint8Array {
	const rnd = xorshift(seed);
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = alphabet[rnd() % alphabet.length]!;
	return out;
}

/** An unclosed quote, then rows with no quote character. */
function csvAdversary(n: number, seed: number): Uint8Array {
	const out = prose(n, seed);
	out[0] = 0x22;
	return out;
}

const seed = 0x2545f491;

/** The input for one subject and kind. `n` is in bytes. */
export function makeInput(subject: string, kind: Kind, n: number): Uint8Array {
	if (kind === 'random') return randomBytes(n, seed);
	switch (subject) {
		case 'utf8flag':
		case 'utf8dfa':
			return kind === 'text' ? prose(n, seed) : overlong(n, seed);
		case 'csvquote':
		case 'csvrows':
			return kind === 'text' ? csv(n, seed) : csvAdversary(n, seed);
		case 'base64ok':
			return kind === 'text' ? mime(n, seed) : alphabetOnly(n, seed);
		case 'rle':
			return kind === 'text'
				? rle(n, seed, (rnd) => 1 + (rnd() % 127))
				: rle(n, seed, () => 1);
		case 'lines':
			return kind === 'text' ? tabbed(n, seed, true) : tabbed(n, seed, false);
		case 'crc32':
		case 'sha256c':
			return kind === 'text' ? prose(n, seed) : new Uint8Array(n);
		default:
			throw new RangeError(`no input for ${subject}`);
	}
}
