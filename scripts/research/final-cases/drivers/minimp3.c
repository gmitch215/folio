#include <stdint.h>
#include <string.h>

#include "harness.h"

#define MINIMP3_IMPLEMENTATION
#include "minimp3.h"

static mp3dec_t dec;

static uint64_t mix(uint64_t x) {
	x ^= x >> 33;
	x *= 0xff51afd7ed558ccdULL;
	x ^= x >> 33;
	return x;
}

static uint8_t rb(const rec_t *r, uint32_t j) { return ((const uint8_t *)P(r->in))[j % r->len]; }

// 16 record bytes that fill the decoder state before init clears it.
static uint32_t gen_bytes(uint32_t i, uint8_t *dst) {
	for (uint32_t j = 0; j < 16; j++) dst[j] = (uint8_t)mix((uint64_t)i * 64 + j);
	return 16;
}

// n samples in [-1.5, 1.5) as multiples of 1/1024, exact in float.
static uint32_t gen_samples(uint32_t i, uint8_t *dst) {
	uint32_t n = 16 + (i * 37) % 1008;
	for (uint32_t j = 0; j < n; j++) {
		uint64_t x = mix((uint64_t)i * 4096 + j + 1);
		float v = (float)(int)(x % 3072) - 1536.0f;
		v /= 1024.0f;
		memcpy(dst + 4 * j, &v, 4);
	}
	return 4 * n;
}

static void set_bits(uint8_t *p, uint32_t pos, uint32_t v, uint32_t n) {
	for (uint32_t k = 0; k < n; k++) {
		uint32_t idx = pos + k;
		if ((v >> (n - 1 - k)) & 1) p[idx >> 3] |= (uint8_t)(0x80 >> (idx & 7));
	}
}

// an MPEG-1 Layer III frame (128 kbps, 44.1 kHz, stereo) with valid side info: main_data_begin 0,
// and each granule and channel codes 64 bits of main data with one Huffman pair (table 1).
// The main data is pseudo-random, so some frames decode and some are rejected.
static uint32_t gen_frame(uint32_t i, uint8_t *dst) {
	dst[0] = 0xFF;
	dst[1] = 0xFB;
	dst[2] = 0x90;
	dst[3] = 0x00;
	uint8_t *side = dst + 4;
	memset(side, 0, 32);
	for (uint32_t gc = 0; gc < 4; gc++) {
		uint32_t base = 20 + gc * 59;
		set_bits(side, base, 64, 12);
		set_bits(side, base + 12, 1, 9);
		set_bits(side, base + 21, 150 + (i % 8), 8);
		set_bits(side, base + 34, 1, 5);
	}
	for (uint32_t j = 36; j < 417; j++) dst[j] = (uint8_t)mix((uint64_t)i * 512 + j);
	return 417;
}

#if defined(K_MP3_INIT)
#define GEN(i, dst) gen_bytes(i, dst)
#elif defined(K_MP3_F32_TO_S16)
#define GEN(i, dst) gen_samples(i, dst)
#elif defined(K_MP3_DECODE_FRAME)
#define GEN(i, dst) gen_frame(i, dst)
#else
#error kernel
#endif

#if defined(K_MP3_INIT)
_Static_assert(sizeof(mp3dec_t) <= SLOT - 32, "slot holds the decoder state");
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	uint8_t *d = (uint8_t *)&dec;
	for (uint32_t j = 0; j < sizeof dec; j++) d[j] = rb(r, j);
	mp3dec_init(&dec);
	memcpy(DATA(out), &dec, sizeof dec);
	W32(out, (uint32_t)sizeof dec);
}
#elif defined(K_MP3_F32_TO_S16)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	uint32_t n = r->len / 4;
	mp3dec_f32_to_s16((const float *)P(r->in), (int16_t *)DATA(out), (int)n);
	W32(out, n);
}
#elif defined(K_MP3_DECODE_FRAME)
_Static_assert(MINIMP3_MAX_SAMPLES_PER_FRAME * sizeof(mp3d_sample_t) <= SLOT - 32,
	"slot holds a frame");
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	mp3dec_frame_info_t info;
	memset(&info, 0, sizeof info);
	mp3dec_init(&dec);
	int n = mp3dec_decode_frame(&dec, (const uint8_t *)P(r->in), (int)r->len,
		(mp3d_sample_t *)DATA(out), &info);
	W32(out, (uint32_t)n);
	W32(out + 4, (uint32_t)info.frame_bytes);
	W32(out + 8, (uint32_t)info.channels);
	W32(out + 12, (uint32_t)info.hz);
	W32(out + 16, (uint32_t)info.layer);
	W32(out + 20, (uint32_t)info.bitrate_kbps);
}
#endif

#include "loop.h"
