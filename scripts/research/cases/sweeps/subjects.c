#include <stdint.h>

#define EXPORT(name) __attribute__((visibility("default"))) name

/* every entry has the shape f(state, ptr, len) -> state and keeps no state outside its argument */

enum { A, N1, N2, N3, E0S, EDS, F0S, F4S };

/* one UTF-8 transition; -1 is an error */
static int u8next(int s, uint8_t b) {
	switch (s) {
	case A:
		if (b < 0x80) return A;
		if (b >= 0xc2 && b <= 0xdf) return N1;
		if (b == 0xe0) return E0S;
		if (b == 0xed) return EDS;
		if ((b >= 0xe1 && b <= 0xec) || (b == 0xee) || (b == 0xef)) return N2;
		if (b == 0xf0) return F0S;
		if (b == 0xf4) return F4S;
		if (b >= 0xf1 && b <= 0xf3) return N3;
		return -1;
	case N1: return b >= 0x80 && b <= 0xbf ? A : -1;
	case N2: return b >= 0x80 && b <= 0xbf ? N1 : -1;
	case N3: return b >= 0x80 && b <= 0xbf ? N2 : -1;
	case E0S: return b >= 0xa0 && b <= 0xbf ? N1 : -1;
	case EDS: return b >= 0x80 && b <= 0x9f ? N1 : -1;
	case F0S: return b >= 0x90 && b <= 0xbf ? N2 : -1;
	case F4S: return b >= 0x80 && b <= 0x8f ? N2 : -1;
	}
	return -1;
}

/* resynchronising validator: on an error the DFA restarts at A and the byte is read again from A */
static uint32_t u8run(uint32_t s, uint32_t err, const uint8_t *p, uint32_t n, uint32_t *out_err) {
	for (uint32_t i = 0; i < n; i++) {
		int t = u8next((int)s, p[i]);
		if (t < 0) {
			err = 1;
			t = u8next(A, p[i]);
			if (t < 0) t = A;
		}
		s = (uint32_t)t;
	}
	*out_err = err;
	return s;
}

/* state: DFA state in bits 0..7, sticky error flag in bit 8 */
uint32_t EXPORT(utf8flag)(uint32_t st, const uint8_t *p, uint32_t n) {
	uint32_t err;
	uint32_t s = u8run(st & 0xffu, st >> 8, p, n, &err);
	return s | (err << 8);
}

/* same DFA with no flag: the state is the DFA state alone */
uint32_t EXPORT(utf8dfa)(uint32_t st, const uint8_t *p, uint32_t n) {
	uint32_t err;
	return u8run(st & 0xffu, 0, p, n, &err);
}

/* state: in-quote bit */
uint32_t EXPORT(csvquote)(uint32_t st, const uint8_t *p, uint32_t n) {
	uint32_t q = st & 1u;
	for (uint32_t i = 0; i < n; i++) q ^= p[i] == '"';
	return q;
}

/* state: in-quote bit, then the row count outside quotes; the count is not part of the DFA */
uint32_t EXPORT(csvrows)(uint32_t st, const uint8_t *p, uint32_t n) {
	uint32_t q = st & 1u, rows = st >> 1;
	for (uint32_t i = 0; i < n; i++) {
		if (p[i] == '"') q ^= 1u;
		else if (p[i] == '\n' && !q) rows++;
	}
	return q | (rows << 1);
}

/* state: bits 0..1 quartet phase, bit 2 owes one more '=', bit 3 rejected (absorbing) */
uint32_t EXPORT(base64ok)(uint32_t st, const uint8_t *p, uint32_t n) {
	uint32_t phase = st & 3u, owed = (st >> 2) & 1u, bad = (st >> 3) & 1u;
	for (uint32_t i = 0; i < n; i++) {
		uint8_t c = p[i];
		if (bad) continue;
		if (owed) {
			if (c == '=') owed = 0, phase = 0;
			else bad = 1;
		} else if (c == '=') {
			if (phase == 2) owed = 1;
			else if (phase == 3) phase = 0;
			else bad = 1;
		} else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			   c == '+' || c == '/') {
			phase = (phase + 1) & 3u;
		} else if (c != '\r' && c != '\n') {
			bad = 1;
		}
	}
	return phase | (owed << 2) | (bad << 3);
}

/* bit 0 expects a value, bits 1..8 last count, bits 9..16 last value, bit 17 rejected */
uint32_t EXPORT(rle)(uint32_t st, const uint8_t *p, uint32_t n) {
	uint32_t phase = st & 1u, cnt = (st >> 1) & 0xffu;
	uint32_t val = (st >> 9) & 0xffu, bad = (st >> 17) & 1u;
	for (uint32_t i = 0; i < n; i++) {
		if (bad) continue;
		if (!phase) {
			if (p[i] == 0) bad = 1;
			else cnt = p[i], phase = 1;
		} else {
			val = p[i], phase = 0;
		}
	}
	return phase | (cnt << 1) | (val << 9) | (bad << 17);
}

/* state: parity of tabs since the last newline (a synchronising DFA: '\n' resets it) */
uint32_t EXPORT(lines)(uint32_t st, const uint8_t *p, uint32_t n) {
	uint32_t s = st & 1u;
	for (uint32_t i = 0; i < n; i++) {
		if (p[i] == '\n') s = 0;
		else if (p[i] == '\t') s ^= 1u;
	}
	return s;
}

static uint32_t crc_table[256];
static int crc_ready;

/* control: reflected CRC-32 (IEEE), affine over GF(2) */
uint32_t EXPORT(crc32)(uint32_t crc, const uint8_t *p, uint32_t n) {
	if (!crc_ready) {
		for (uint32_t i = 0; i < 256; i++) {
			uint32_t c = i;
			for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320u & -(c & 1u));
			crc_table[i] = c;
		}
		crc_ready = 1;
	}
	crc = ~crc;
	for (uint32_t i = 0; i < n; i++) crc = (crc >> 8) ^ crc_table[(crc ^ p[i]) & 0xffu];
	return ~crc;
}

static const uint32_t sha_k[64] = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};
static const uint32_t sha_iv[8] = {
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
};
#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

/* control: one compression per 64-byte block; the chaining state is the i32 in slot 0 */
uint32_t EXPORT(sha256c)(uint32_t state, const uint8_t *p, uint32_t n) {
	for (uint32_t blocks = n / 64; blocks; blocks--, p += 64) {
		uint32_t w[64], h[8];
		for (int i = 0; i < 8; i++) h[i] = sha_iv[i];
		h[0] = state;
		for (int i = 0; i < 16; i++)
			w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 |
			       (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
		for (int i = 16; i < 64; i++) {
			uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
			uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
			w[i] = w[i - 16] + s0 + w[i - 7] + s1;
		}
		uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
		for (int i = 0; i < 64; i++) {
			uint32_t t1 = hh + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) + ((e & f) ^ (~e & g)) +
				      sha_k[i] + w[i];
			uint32_t t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
			hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
		}
		state = h[0] + a;
	}
	return state;
}
