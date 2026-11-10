#include <stdint.h>
#include <string.h>

#include "harness.h"
#include "zstd.h"

#define W64(p, v) (*(uint64_t *)(p) = (uint64_t)(v))
#define DICT_LEN 128
#define LEVEL 3

static uint8_t dict[DICT_LEN];
static uint8_t scratch[1024];

static void dict_fill(void) {
	for (uint32_t j = 0; j < DICT_LEN; j++) dict[j] = (uint8_t)(j * 29 + 7);
}

static uint32_t raw_len(uint32_t i) { return 64 + (i * 37) % 704; }

static uint32_t gen_raw(uint32_t i, uint8_t *dst) {
	uint32_t len = raw_len(i);
	dict_fill();
	raw_fill(dst, len);
	return len;
}

// frames made by the library itself, so the decoders see real zstd streams.
static uint32_t gen_frame(uint32_t i, uint8_t *dst) {
	uint32_t len = raw_len(i);
	dict_fill();
	bump_set(P(gen_arena), GEN_ARENA);
	raw_fill(scratch, len);
	return (uint32_t)ZSTD_compress(dst, REC_CAP, scratch, len, LEVEL);
}

static uint32_t gen_frame_dict(uint32_t i, uint8_t *dst) {
	uint32_t len = raw_len(i);
	dict_fill();
	bump_set(P(gen_arena), GEN_ARENA);
	raw_fill(scratch, len);
	ZSTD_CCtx *cctx = ZSTD_createCCtx();
	size_t n = ZSTD_compress_usingDict(cctx, dst, REC_CAP, scratch, len, dict, DICT_LEN, LEVEL);
	ZSTD_freeCCtx(cctx);
	return (uint32_t)n;
}

#if defined(K_COMPRESS)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	W64(out, ZSTD_compress(DATA(out), SLOT - 32, P(r->in), r->len, LEVEL));
}
#elif defined(K_DECOMPRESS)
#define GEN(i, dst) gen_frame(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	W64(out, ZSTD_decompress(DATA(out), SLOT - 32, P(r->in), r->len));
}
#elif defined(K_GET_FRAME_CONTENT_SIZE)
#define GEN(i, dst) gen_frame(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	W64(out, ZSTD_getFrameContentSize(P(r->in), r->len));
}
#elif defined(K_GET_DECOMPRESSED_SIZE)
#define GEN(i, dst) gen_frame(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	W64(out, ZSTD_getDecompressedSize(P(r->in), r->len));
}
#elif defined(K_FIND_FRAME_COMPRESSED_SIZE)
#define GEN(i, dst) gen_frame(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	W64(out, ZSTD_findFrameCompressedSize(P(r->in), r->len));
}
#elif defined(K_COMPRESS_CCTX)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	ZSTD_CCtx *cctx = ZSTD_createCCtx();
	W64(out, ZSTD_compressCCtx(cctx, DATA(out), SLOT - 32, P(r->in), r->len, LEVEL));
	ZSTD_freeCCtx(cctx);
}
#elif defined(K_DECOMPRESS_DCTX)
#define GEN(i, dst) gen_frame(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	ZSTD_DCtx *dctx = ZSTD_createDCtx();
	W64(out, ZSTD_decompressDCtx(dctx, DATA(out), SLOT - 32, P(r->in), r->len));
	ZSTD_freeDCtx(dctx);
}
#elif defined(K_CCTX_SET_PLEDGED_SRC_SIZE)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	ZSTD_CCtx *cctx = ZSTD_createCCtx();
	W64(out, ZSTD_CCtx_setPledgedSrcSize(cctx, r->len));
	ZSTD_freeCCtx(cctx);
}
#elif defined(K_COMPRESS2)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	ZSTD_CCtx *cctx = ZSTD_createCCtx();
	W64(out, ZSTD_compress2(cctx, DATA(out), SLOT - 32, P(r->in), r->len));
	ZSTD_freeCCtx(cctx);
}
#elif defined(K_COMPRESS_USING_DICT)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	ZSTD_CCtx *cctx = ZSTD_createCCtx();
	W64(out, ZSTD_compress_usingDict(cctx, DATA(out), SLOT - 32, P(r->in), r->len, dict,
		DICT_LEN, LEVEL));
	ZSTD_freeCCtx(cctx);
}
#elif defined(K_DECOMPRESS_USING_DICT)
#define GEN(i, dst) gen_frame_dict(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	ZSTD_DCtx *dctx = ZSTD_createDCtx();
	W64(out, ZSTD_decompress_usingDict(dctx, DATA(out), SLOT - 32, P(r->in), r->len, dict,
		DICT_LEN));
	ZSTD_freeDCtx(dctx);
}
#elif defined(K_CREATE_CDICT)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	ZSTD_CDict *cdict = ZSTD_createCDict(P(r->in), r->len, LEVEL);
	W32(out, cdict != NULL);
	W32(out + 4, cdict ? ZSTD_getDictID_fromCDict(cdict) : 0);
	ZSTD_freeCDict(cdict);
}
#else
#error kernel
#endif

#include "loop.h"
