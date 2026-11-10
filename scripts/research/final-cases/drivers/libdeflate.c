#include <stdint.h>
#include <string.h>

#include "libdeflate.h"
#include "harness.h"

static uint32_t raw_len(uint32_t i) { return 64 + (i * 37) % 960; }

static uint32_t gen_raw(uint32_t i, uint8_t *dst) {
	uint32_t len = raw_len(i);
	raw_fill(dst, len);
	return len;
}

// format 0 deflate, 1 zlib, 2 gzip; decompress drivers read the stream of their format.
static uint32_t gen_stream(uint32_t i, uint8_t *dst, int format) {
	static uint8_t raw[1024];
	uint32_t len = raw_len(i);
	raw_fill(raw, len);
	bump_set(P(gen_arena), GEN_ARENA);
	struct libdeflate_compressor *c = libdeflate_alloc_compressor(6);
	size_t n = format == 0	? libdeflate_deflate_compress(c, raw, len, dst, REC_CAP)
		   : format == 1 ? libdeflate_zlib_compress(c, raw, len, dst, REC_CAP)
				 : libdeflate_gzip_compress(c, raw, len, dst, REC_CAP);
	libdeflate_free_compressor(c);
	return (uint32_t)n;
}

#if defined(K_DEFLATE_DECOMPRESS) || defined(K_DEFLATE_DECOMPRESS_EX)
#define GEN(i, dst) gen_stream(i, dst, 0)
#elif defined(K_ZLIB_DECOMPRESS) || defined(K_ZLIB_DECOMPRESS_EX)
#define GEN(i, dst) gen_stream(i, dst, 1)
#elif defined(K_GZIP_DECOMPRESS) || defined(K_GZIP_DECOMPRESS_EX)
#define GEN(i, dst) gen_stream(i, dst, 2)
#else
#define GEN(i, dst) gen_raw(i, dst)
#endif

#if defined(K_DEFLATE_COMPRESS)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_compressor *c = libdeflate_alloc_compressor(6);
	W32(out, libdeflate_deflate_compress(c, P(r->in), r->len, DATA(out), SLOT - 32));
	libdeflate_free_compressor(c);
}
#elif defined(K_ZLIB_COMPRESS)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_compressor *c = libdeflate_alloc_compressor(6);
	W32(out, libdeflate_zlib_compress(c, P(r->in), r->len, DATA(out), SLOT - 32));
	libdeflate_free_compressor(c);
}
#elif defined(K_GZIP_COMPRESS)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_compressor *c = libdeflate_alloc_compressor(6);
	W32(out, libdeflate_gzip_compress(c, P(r->in), r->len, DATA(out), SLOT - 32));
	libdeflate_free_compressor(c);
}
#elif defined(K_DEFLATE_COMPRESS_BOUND)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_compressor *c = libdeflate_alloc_compressor(6);
	W32(out, libdeflate_deflate_compress_bound(c, r->len));
	libdeflate_free_compressor(c);
}
#elif defined(K_ZLIB_COMPRESS_BOUND)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_compressor *c = libdeflate_alloc_compressor(6);
	W32(out, libdeflate_zlib_compress_bound(c, r->len));
	libdeflate_free_compressor(c);
}
#elif defined(K_GZIP_COMPRESS_BOUND)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_compressor *c = libdeflate_alloc_compressor(6);
	W32(out, libdeflate_gzip_compress_bound(c, r->len));
	libdeflate_free_compressor(c);
}
#elif defined(K_DEFLATE_DECOMPRESS)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_decompressor *d = libdeflate_alloc_decompressor();
	size_t actual = 0;
	enum libdeflate_result res =
		libdeflate_deflate_decompress(d, P(r->in), r->len, DATA(out), SLOT - 32, &actual);
	W32(out, res);
	W32(out + 4, actual);
	libdeflate_free_decompressor(d);
}
#elif defined(K_ZLIB_DECOMPRESS)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_decompressor *d = libdeflate_alloc_decompressor();
	size_t actual = 0;
	enum libdeflate_result res =
		libdeflate_zlib_decompress(d, P(r->in), r->len, DATA(out), SLOT - 32, &actual);
	W32(out, res);
	W32(out + 4, actual);
	libdeflate_free_decompressor(d);
}
#elif defined(K_GZIP_DECOMPRESS)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_decompressor *d = libdeflate_alloc_decompressor();
	size_t actual = 0;
	enum libdeflate_result res =
		libdeflate_gzip_decompress(d, P(r->in), r->len, DATA(out), SLOT - 32, &actual);
	W32(out, res);
	W32(out + 4, actual);
	libdeflate_free_decompressor(d);
}
#elif defined(K_DEFLATE_DECOMPRESS_EX)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_decompressor *d = libdeflate_alloc_decompressor();
	size_t in_used = 0, out_used = 0;
	enum libdeflate_result res = libdeflate_deflate_decompress_ex(
		d, P(r->in), r->len, DATA(out), SLOT - 32, &in_used, &out_used);
	W32(out, res);
	W32(out + 4, in_used);
	W32(out + 8, out_used);
	libdeflate_free_decompressor(d);
}
#elif defined(K_ZLIB_DECOMPRESS_EX)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_decompressor *d = libdeflate_alloc_decompressor();
	size_t in_used = 0, out_used = 0;
	enum libdeflate_result res = libdeflate_zlib_decompress_ex(
		d, P(r->in), r->len, DATA(out), SLOT - 32, &in_used, &out_used);
	W32(out, res);
	W32(out + 4, in_used);
	W32(out + 8, out_used);
	libdeflate_free_decompressor(d);
}
#elif defined(K_GZIP_DECOMPRESS_EX)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	struct libdeflate_decompressor *d = libdeflate_alloc_decompressor();
	size_t in_used = 0, out_used = 0;
	enum libdeflate_result res = libdeflate_gzip_decompress_ex(
		d, P(r->in), r->len, DATA(out), SLOT - 32, &in_used, &out_used);
	W32(out, res);
	W32(out + 4, in_used);
	W32(out + 8, out_used);
	libdeflate_free_decompressor(d);
}
#else
#error kernel
#endif

#include "loop.h"
