#include <stdint.h>
#include <string.h>

#include "harness.h"
#include "pffft.h"

// complex transform length; the record holds 2 * FFT_N floats (or 4 * FFT_N for the two-operand kernels).
#define FFT_N 64

static uint32_t gen_cplx(uint32_t i, uint8_t *dst) {
	float *f = (float *)dst;
	uint32_t n = 2 * FFT_N;
	for (uint32_t j = 0; j < n; j++) f[j] = (float)(((j * 13 + i + (j >> 7)) & 255) - 128) / 128.0f;
	return n * 4;
}

static uint32_t gen_two(uint32_t i, uint8_t *dst) {
	float *f = (float *)dst;
	uint32_t n = 4 * FFT_N;
	for (uint32_t j = 0; j < n; j++) f[j] = (float)(((j * 13 + i + (j >> 7)) & 255) - 128) / 128.0f;
	return n * 4;
}

#if defined(K_DESTROY_SETUP)
#define GEN(i, dst) gen_cplx(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	(void)r;
	bump_set(P(r->arena), ARENA);
	PFFFT_Setup *s = pffft_new_setup(FFT_N, PFFFT_COMPLEX);
	pffft_destroy_setup(s);
	W32(out, FFT_N);
}
#elif defined(K_TRANSFORM)
#define GEN(i, dst) gen_cplx(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	PFFFT_Setup *s = pffft_new_setup(FFT_N, PFFFT_COMPLEX);
	float *work = pffft_aligned_malloc(2 * FFT_N * sizeof(float));
	pffft_transform(s, (const float *)P(r->in), (float *)DATA(out), work, PFFFT_FORWARD);
	pffft_aligned_free(work);
	pffft_destroy_setup(s);
	W32(out, FFT_N);
}
#elif defined(K_TRANSFORM_ORDERED)
#define GEN(i, dst) gen_cplx(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	PFFFT_Setup *s = pffft_new_setup(FFT_N, PFFFT_COMPLEX);
	float *work = pffft_aligned_malloc(2 * FFT_N * sizeof(float));
	pffft_transform_ordered(s, (const float *)P(r->in), (float *)DATA(out), work, PFFFT_FORWARD);
	pffft_aligned_free(work);
	pffft_destroy_setup(s);
	W32(out, FFT_N);
}
#elif defined(K_ZREORDER)
#define GEN(i, dst) gen_cplx(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	PFFFT_Setup *s = pffft_new_setup(FFT_N, PFFFT_COMPLEX);
	pffft_zreorder(s, (const float *)P(r->in), (float *)DATA(out), PFFFT_FORWARD);
	pffft_destroy_setup(s);
	W32(out, FFT_N);
}
#elif defined(K_ZCONVOLVE_ACCUMULATE)
#define GEN(i, dst) gen_two(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	const float *a = (const float *)P(r->in);
	PFFFT_Setup *s = pffft_new_setup(FFT_N, PFFFT_COMPLEX);
	pffft_zconvolve_accumulate(s, a, a + 2 * FFT_N, (float *)DATA(out), 1.0f / FFT_N);
	pffft_destroy_setup(s);
	W32(out, FFT_N);
}
#elif defined(K_ZCONVOLVE_SCALE)
#define GEN(i, dst) gen_two(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	const float *a = (const float *)P(r->in);
	PFFFT_Setup *s = pffft_new_setup(FFT_N, PFFFT_COMPLEX);
	pffft_zconvolve_scale(s, a, a + 2 * FFT_N, (float *)DATA(out), 1.0f / FFT_N);
	pffft_destroy_setup(s);
	W32(out, FFT_N);
}
#elif defined(K_ZCONVOLVE)
#define GEN(i, dst) gen_two(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	const float *a = (const float *)P(r->in);
	PFFFT_Setup *s = pffft_new_setup(FFT_N, PFFFT_COMPLEX);
	pffft_zconvolve(s, a, a + 2 * FFT_N, (float *)DATA(out));
	pffft_destroy_setup(s);
	W32(out, FFT_N);
}
#elif defined(K_ZCONVOLVE_NO_ACCU)
#define GEN(i, dst) gen_two(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	const float *a = (const float *)P(r->in);
	PFFFT_Setup *s = pffft_new_setup(FFT_N, PFFFT_COMPLEX);
	pffft_zconvolve_no_accu(s, a, a + 2 * FFT_N, (float *)DATA(out), 1.0f / FFT_N);
	pffft_destroy_setup(s);
	W32(out, FFT_N);
}
#elif defined(K_ZCONVERT_ZP)
#define GEN(i, dst) gen_cplx(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	PFFFT_Setup *s = pffft_new_setup(FFT_N, PFFFT_REAL);
	W32(out, pffft_zconvert_zp(s, (const float *)P(r->in), (float *)DATA(out), 1.0f));
	pffft_destroy_setup(s);
}
#elif defined(K_ZCONVOLVE_ZP)
#define GEN(i, dst) gen_two(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	const float *a = (const float *)P(r->in);
	PFFFT_Setup *s = pffft_new_setup(FFT_N, PFFFT_REAL);
	W32(out, pffft_zconvolve_zp(s, a, a + FFT_N, (float *)DATA(out)));
	pffft_destroy_setup(s);
}
#elif defined(K_ALIGNED_FREE)
#define GEN(i, dst) gen_cplx(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	float *buf = pffft_aligned_malloc(2 * FFT_N * sizeof(float));
	memcpy(buf, P(r->in), 2 * FFT_N * sizeof(float));
	memcpy(DATA(out), buf, 2 * FFT_N * sizeof(float));
	pffft_aligned_free(buf);
	W32(out, FFT_N);
}
#elif defined(K_PFFFTD_DESTROY_SETUP)
#include "pffft_double.h"
#define GEN(i, dst) gen_cplx(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	(void)r;
	bump_set(P(r->arena), ARENA);
	PFFFTD_Setup *s = pffftd_new_setup(FFT_N, PFFFT_COMPLEX);
	pffftd_destroy_setup(s);
	W32(out, FFT_N);
}
#else
#error kernel
#endif

#include "loop.h"
