#include <stdint.h>
#include <string.h>

#include "harness.h"
#include "ryu/ryu.h"

static uint64_t mix(uint64_t x) {
	x ^= x >> 33;
	x *= 0xff51afd7ed558ccdULL;
	x ^= x >> 33;
	return x;
}

// dyadic doubles with exponents from 2^-16 to 2^19, exact in both targets.
static uint32_t gen_d(uint32_t i, uint8_t *dst) {
	uint64_t x = mix((uint64_t)i + 1);
	double v = (double)(uint32_t)(x >> 32) * (double)(1u << (i % 20)) / 65536.0;
	if (x & 1) v = -v;
	memcpy(dst, &v, 8);
	return 8;
}

// dyadic floats, exact in float for every exponent used here.
static uint32_t gen_f(uint32_t i, uint8_t *dst) {
	uint64_t x = mix((uint64_t)i + 1);
	float v = (float)(uint32_t)(x >> 40) * (float)(1u << (i % 20)) / 256.0f;
	if (x & 1) v = -v;
	memcpy(dst, &v, 4);
	return 4;
}

#if defined(K_D2S_BUFFERED_N) || defined(K_D2S_BUFFERED)
#define GEN(i, dst) gen_d(i, dst)
#else
#define GEN(i, dst) gen_f(i, dst)
#endif

#if defined(K_D2S_BUFFERED_N)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	double f;
	memcpy(&f, P(r->in), 8);
	W32(out, d2s_buffered_n(f, (char *)DATA(out)));
}
#elif defined(K_D2S_BUFFERED)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	double f;
	memcpy(&f, P(r->in), 8);
	d2s_buffered(f, (char *)DATA(out));
	W32(out, (uint32_t)strlen((char *)DATA(out)));
}
#elif defined(K_F2S_BUFFERED_N)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	float f;
	memcpy(&f, P(r->in), 4);
	W32(out, f2s_buffered_n(f, (char *)DATA(out)));
}
#elif defined(K_F2S_BUFFERED)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	float f;
	memcpy(&f, P(r->in), 4);
	f2s_buffered(f, (char *)DATA(out));
	W32(out, (uint32_t)strlen((char *)DATA(out)));
}
#else
#error kernel
#endif

#include "loop.h"
