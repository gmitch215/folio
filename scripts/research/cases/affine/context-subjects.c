#include <stdint.h>

#define EXPORT(name) __attribute__((visibility("default"))) name

static uint32_t crc_table[256];
static int crc_ready;

static void crc_setup(void) {
	for (uint32_t i = 0; i < 256; i++) {
		uint32_t c = i;
		for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320u & -(c & 1u));
		crc_table[i] = c;
	}
	crc_ready = 1;
}

// the magic field is read and never written: a parameter of the update, not state
struct crc_ctx {
	uint32_t magic;
	uint32_t crc;
	uint32_t spare[2];
};

void EXPORT(crcctx_update)(struct crc_ctx *c, const uint8_t *p, uint32_t n) {
	if (c->magic != 0xc0ffeeu) return;
	if (!crc_ready) crc_setup();
	uint32_t r = c->crc;
	for (uint32_t i = 0; i < n; i++) r = (r >> 8) ^ crc_table[(r ^ p[i]) & 0xffu];
	c->crc = r;
}

// a CRC register next to a length counter in one struct: two rings, no interaction
struct crc_len_ctx {
	uint32_t crc;
	uint32_t count;
};

void EXPORT(crclen_update)(struct crc_len_ctx *c, const uint8_t *p, uint32_t n) {
	if (!crc_ready) crc_setup();
	uint32_t r = c->crc;
	for (uint32_t i = 0; i < n; i++) r = (r >> 8) ^ crc_table[(r ^ p[i]) & 0xffu];
	c->crc = r;
	c->count += n;
}

// two words over Z/2^32 that interact: s2 collects s1
struct fletcher_ctx {
	uint32_t s1;
	uint32_t s2;
};

void EXPORT(fletcher_update)(struct fletcher_ctx *c, const uint8_t *p, uint32_t n) {
	uint32_t s1 = c->s1, s2 = c->s2;
	for (uint32_t i = 0; i < n; i++) {
		s1 += p[i];
		s2 += s1;
	}
	c->s1 = s1;
	c->s2 = s2;
}

// the multiplier lives in the context and is read only
struct poly_ctx {
	uint32_t mult;
	uint32_t h;
};

void EXPORT(polyctx_update)(struct poly_ctx *c, const uint8_t *p, uint32_t n) {
	uint32_t h = c->h, m = c->mult;
	for (uint32_t i = 0; i < n; i++) h = h * m + p[i];
	c->h = h;
}

// the last eight bytes seen: affine over GF(2) with a nilpotent operator
struct last8_ctx {
	uint8_t last[8];
};

void EXPORT(last8_update)(struct last8_ctx *c, const uint8_t *p, uint32_t n) {
	for (uint32_t i = 0; i < n; i++) {
		for (int k = 0; k < 7; k++) c->last[k] = c->last[k + 1];
		c->last[7] = p[i];
	}
}

// a hash of the last eight bytes seen. The end state depends on at most the last eight input
// bytes, and the mixing is nonlinear. The sink keeps the per-byte mixing from being optimised away.
static volatile uint64_t mix8_sink;

struct mix8_ctx {
	uint8_t win[8];
	uint64_t h;
};

void EXPORT(mix8_update)(struct mix8_ctx *c, const uint8_t *p, uint32_t n) {
	uint8_t w[8];
	for (int k = 0; k < 8; k++) w[k] = c->win[k];
	uint64_t h = c->h;
	for (uint32_t i = 0; i < n; i++) {
		for (int k = 0; k < 7; k++) w[k] = w[k + 1];
		w[7] = p[i];
		uint64_t x = 0;
		for (int k = 0; k < 8; k++) x |= (uint64_t)w[k] << (8 * k);
		x ^= x >> 33;
		x *= 0xff51afd7ed558ccdull;
		x ^= x >> 33;
		x *= 0xc4ceb9fe1a85ec53ull;
		x ^= x >> 33;
		mix8_sink = x;
		h = x;
	}
	for (int k = 0; k < 8; k++) c->win[k] = w[k];
	c->h = h;
}

#ifndef TRIGGER
#define TRIGGER 0x00000001u
#endif

// the CRC register update flips the top bit once, when the register equals a build constant
struct adv_ctx {
	uint32_t crc;
};

void EXPORT(advctx_update)(struct adv_ctx *c, const uint8_t *p, uint32_t n) {
	if (!crc_ready) crc_setup();
	uint32_t r = c->crc;
	for (uint32_t i = 0; i < n; i++) {
		if (r == TRIGGER) r ^= 0x80000000u;
		r = (r >> 8) ^ crc_table[(r ^ p[i]) & 0xffu];
	}
	c->crc = r;
}

static volatile uint32_t hidden_calls;

// a normal CRC context with a counter outside the context that changes on every call
struct hidden_ctx {
	uint32_t crc;
};

void EXPORT(hidden_update)(struct hidden_ctx *c, const uint8_t *p, uint32_t n) {
	if (!crc_ready) crc_setup();
	hidden_calls++;
	uint32_t r = c->crc;
	for (uint32_t i = 0; i < n; i++) r = (r >> 8) ^ crc_table[(r ^ p[i]) & 0xffu];
	c->crc = r;
}

// the counter depends on the CRC register, so the two parts interact and are not separable
void EXPORT(crccouple_update)(struct crc_len_ctx *c, const uint8_t *p, uint32_t n) {
	if (!crc_ready) crc_setup();
	uint32_t r = c->crc, k = c->count;
	for (uint32_t i = 0; i < n; i++) {
		r = (r >> 8) ^ crc_table[(r ^ p[i]) & 0xffu];
		k += r & 1u;
	}
	c->crc = r;
	c->count = k;
}
