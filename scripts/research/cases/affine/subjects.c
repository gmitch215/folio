#include <stdint.h>

#define EXPORT(name) __attribute__((visibility("default"))) name

uint32_t EXPORT(crc32c)(uint32_t crc, const uint8_t *p, uint32_t n) {
	crc = ~crc;
	for (uint32_t i = 0; i < n; i++) {
		crc ^= p[i];
		for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0x82f63b78u & -(crc & 1u));
	}
	return ~crc;
}

static uint16_t crc16_table[256];
static int crc16_ready;

uint32_t EXPORT(crc16)(uint32_t crc, const uint8_t *p, uint32_t n) {
	if (!crc16_ready) {
		for (uint32_t i = 0; i < 256; i++) {
			uint32_t c = i;
			for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xa001u & -(c & 1u));
			crc16_table[i] = (uint16_t)c;
		}
		crc16_ready = 1;
	}
	crc &= 0xffffu;
	for (uint32_t i = 0; i < n; i++) crc = (crc >> 8) ^ crc16_table[(crc ^ p[i]) & 0xffu];
	return crc;
}

static uint64_t crc64_table[256];
static int crc64_ready;

uint64_t EXPORT(crc64)(uint64_t crc, const uint8_t *p, uint32_t n) {
	if (!crc64_ready) {
		for (uint64_t i = 0; i < 256; i++) {
			uint64_t c = i;
			for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xc96c5795d7870f42ull & -(c & 1ull));
			crc64_table[i] = c;
		}
		crc64_ready = 1;
	}
	crc = ~crc;
	for (uint32_t i = 0; i < n; i++) crc = (crc >> 8) ^ crc64_table[(crc ^ p[i]) & 0xffu];
	return ~crc;
}

uint32_t EXPORT(poly31)(uint32_t h, const uint8_t *p, uint32_t n) {
	for (uint32_t i = 0; i < n; i++) h = h * 31u + p[i];
	return h;
}

uint32_t EXPORT(lcg)(uint32_t s, const uint8_t *p, uint32_t n) {
	for (uint32_t i = 0; i < n; i++) s = s * 1664525u + 1013904223u + p[i];
	return s;
}

uint32_t EXPORT(fnv1a)(uint32_t h, const uint8_t *p, uint32_t n) {
	for (uint32_t i = 0; i < n; i++) {
		h ^= p[i];
		h *= 16777619u;
	}
	return h;
}

uint32_t EXPORT(adler32)(uint32_t adler, const uint8_t *p, uint32_t n) {
	uint32_t s1 = adler & 0xffffu, s2 = adler >> 16;
	for (uint32_t i = 0; i < n; i++) {
		s1 = (s1 + p[i]) % 65521u;
		s2 = (s2 + s1) % 65521u;
	}
	return (s2 << 16) | s1;
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

// one compression per 64-byte block; the chaining state is the i32 word in slot 0 and the fixed IV elsewhere
uint32_t EXPORT(sha256c)(uint32_t state, const uint8_t *p, uint32_t n) {
	for (uint32_t blocks = n / 64; blocks; blocks--, p += 64) {
		uint32_t w[64], h[8];
		for (int i = 0; i < 8; i++) h[i] = sha_iv[i];
		h[0] = state;
		for (int i = 0; i < 16; i++)
			w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 | (uint32_t)p[4 * i + 2] << 8 | p[4 * i + 3];
		for (int i = 16; i < 64; i++) {
			uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
			uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
			w[i] = w[i - 16] + s0 + w[i - 7] + s1;
		}
		uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
		for (int i = 0; i < 64; i++) {
			uint32_t t1 = hh + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) + ((e & f) ^ (~e & g)) + sha_k[i] + w[i];
			uint32_t t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
			hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
		}
		state = h[0] + a;
	}
	return state;
}

#ifndef TRIGGER
#define TRIGGER 0x00000001u
#endif

static uint32_t adv_table[256];
static int adv_ready;

// CRC-32 register update that flips the top bit when the register equals one value; the value is
// a build constant, so no probe reaches it and the function is a plain CRC everywhere else
uint32_t EXPORT(adv)(uint32_t crc, const uint8_t *p, uint32_t n) {
	if (!adv_ready) {
		for (uint32_t i = 0; i < 256; i++) {
			uint32_t c = i;
			for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320u & -(c & 1u));
			adv_table[i] = c;
		}
		adv_ready = 1;
	}
	for (uint32_t i = 0; i < n; i++) {
		if (crc == TRIGGER) crc ^= 0x80000000u;
		crc = (crc >> 8) ^ adv_table[(crc ^ p[i]) & 0xffu];
	}
	return crc;
}

// transforms in place: byte i is replaced by a function of itself and the generator state before it
uint32_t EXPORT(xlcg)(uint32_t s, uint8_t *p, uint32_t n) {
	for (uint32_t i = 0; i < n; i++) {
		s = s * 1664525u + 1013904223u;
		p[i] ^= (uint8_t)(s >> 24);
	}
	return s;
}

uint32_t EXPORT(xshift)(uint32_t s, uint8_t *p, uint32_t n) {
	for (uint32_t i = 0; i < n; i++) {
		s ^= s << 13;
		s ^= s >> 17;
		s ^= s << 5;
		p[i] ^= (uint8_t)s;
	}
	return s;
}

#define SB(i) ((uint8_t)((i) * 167u + 13u))
#define SB4(n) SB(n), SB(n + 1), SB(n + 2), SB(n + 3)
#define SB16(n) SB4(n), SB4(n + 4), SB4(n + 8), SB4(n + 12)
#define SB64(n) SB16(n), SB16(n + 16), SB16(n + 32), SB16(n + 48)
static const uint8_t sbox[256] = {SB64(0), SB64(64), SB64(128), SB64(192)};

uint32_t EXPORT(xsbox)(uint32_t s, uint8_t *p, uint32_t n) {
	for (uint32_t i = 0; i < n; i++) {
		s ^= s << 13;
		s ^= s >> 17;
		s ^= s << 5;
		p[i] ^= sbox[s & 0xffu];
	}
	return s;
}

// the state reads the input byte, so the chunks cannot start without running the ones before them
uint32_t EXPORT(xfeed)(uint32_t s, uint8_t *p, uint32_t n) {
	for (uint32_t i = 0; i < n; i++) {
		s = s * 31u + p[i];
		p[i] ^= (uint8_t)(s >> 24);
	}
	return s;
}
