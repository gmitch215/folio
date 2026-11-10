#include <stdint.h>
#include <string.h>

#include "codecs.h"
#include "harness.h"
#include "libbase64.h"

// codec_choose.c names the simd codecs in its forced-flag branches. the config disables them and
// every adapter passes flags 0, so these stubs are linked and never called.
#define SIMD_STUB(arch)                                    \
	void base64_stream_encode_##arch BASE64_ENC_PARAMS { __builtin_trap(); } \
	int base64_stream_decode_##arch BASE64_DEC_PARAMS { __builtin_trap(); }
SIMD_STUB(ssse3)
SIMD_STUB(sse41)
SIMD_STUB(sse42)
SIMD_STUB(avx)
SIMD_STUB(avx2)
SIMD_STUB(avx512)
SIMD_STUB(neon32)
SIMD_STUB(neon64)

static uint32_t raw_len(uint32_t i) { return 1 + (i * 37) % 1000; }

static uint32_t gen_raw(uint32_t i, uint8_t *dst) {
	uint32_t len = raw_len(i);
	raw_fill(dst, len);
	return len;
}

// decode inputs are base64 text of a shorter raw record, made by the library's own encoder.
static uint32_t gen_text(uint32_t i, uint8_t *dst) {
	static uint8_t raw[1024];
	uint32_t len = 1 + (i * 37) % 768;
	raw_fill(raw, len);
	size_t n = 0;
	base64_encode((const char *)raw, len, (char *)dst, &n, 0);
	return (uint32_t)n;
}

#if defined(K_DECODE) || defined(K_STREAM_DECODE)
#define GEN(i, dst) gen_text(i, dst)
#else
#define GEN(i, dst) gen_raw(i, dst)
#endif

#if defined(K_ENCODE)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t n = 0;
	base64_encode((const char *)P(r->in), r->len, (char *)DATA(out), &n, 0);
	W32(out, n);
}
#elif defined(K_STREAM_ENCODE)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	struct base64_state st;
	size_t n = 0, m = 0;
	base64_stream_encode_init(&st, 0);
	base64_stream_encode(&st, (const char *)P(r->in), r->len, (char *)DATA(out), &n);
	base64_stream_encode_final(&st, (char *)DATA(out) + n, &m);
	W32(out, n + m);
}
#elif defined(K_DECODE)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t n = 0;
	int ok = base64_decode((const char *)P(r->in), r->len, (char *)DATA(out), &n, 0);
	W32(out, ok);
	W32(out + 4, n);
}
#elif defined(K_STREAM_DECODE)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	struct base64_state st;
	size_t n = 0;
	base64_stream_decode_init(&st, 0);
	int ok = base64_stream_decode(&st, (const char *)P(r->in), r->len, (char *)DATA(out), &n);
	W32(out, ok);
	W32(out + 4, n);
}
#else
#error kernel
#endif

#include "loop.h"
