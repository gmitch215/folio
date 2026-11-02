#include <stdint.h>
#include <string.h>
#include <stdlib.h>

/* one record: input, input length, per-record auxiliary data, private allocator slice */
typedef struct {
	uint32_t in, len, aux, arena;
} rec_t;

/* every record owns SLOT bytes of output, a multiple of 32; word 0 is the return value */
#ifndef SLOT
#error SLOT
#endif
#define W32(p, v) (*(uint32_t *)(p) = (uint32_t)(v))
#define W64(p, v) (*(uint64_t *)(p) = (uint64_t)(v))
#define DATA(out) ((out) + 32)

#define NOINLINE __attribute__((noinline))

void bump_set(void *base, size_t size);

#if defined(K_LZ4C)
#include "lz4.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	W32(out, LZ4_compress_default((const char *)r->in, (char *)DATA(out), (int)r->len, SLOT - 32));
}
#elif defined(K_LZ4D)
#include "lz4.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	W32(out, LZ4_decompress_safe((const char *)r->in, (char *)DATA(out), (int)r->len, SLOT - 32));
}
#elif defined(K_MZC)
#include "miniz.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	mz_ulong size = SLOT - 32;
	bump_set((void *)r->arena, ARENA);
	int status = mz_compress(DATA(out), &size, (const unsigned char *)r->in, r->len);
	W32(out, status);
	W32(out + 4, size);
}
#elif defined(K_MZD)
#include "miniz.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	mz_ulong size = SLOT - 32;
	bump_set((void *)r->arena, ARENA);
	int status = mz_uncompress(DATA(out), &size, (const unsigned char *)r->in, r->len);
	W32(out, status);
	W32(out + 4, size);
}
#elif defined(K_CRC32)
#include "miniz.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	W32(out, mz_crc32(0, (const unsigned char *)r->in, r->len));
}
#elif defined(K_ADLER32)
#include "miniz.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	W32(out, mz_adler32(1, (const unsigned char *)r->in, r->len));
}
#elif defined(K_JSMN)
#include "jsmn.h"
#define TOKENS ((SLOT - 32) / 16)
#ifdef SHARED
static jsmn_parser parser;
static jsmntok_t tokens[TOKENS];
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	memset(tokens, 0, sizeof(tokens));
	jsmn_init(&parser);
	int used = jsmn_parse(&parser, (const char *)r->in, r->len, tokens, TOKENS);
	memcpy(DATA(out), tokens, sizeof(tokens));
	W32(out, used);
}
#elif defined(CTXARENA)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	jsmn_parser *parser = (jsmn_parser *)r->arena;
	jsmn_init(parser);
	W32(out, jsmn_parse(parser, (const char *)r->in, r->len, (jsmntok_t *)DATA(out), TOKENS));
}
#else
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	jsmn_parser parser;
	jsmn_init(&parser);
	W32(out, jsmn_parse(&parser, (const char *)r->in, r->len, (jsmntok_t *)DATA(out), TOKENS));
}
#endif
#elif defined(K_KFFT)
#include "kiss_fft.h"
void setup(void *mem, uint32_t count, uint32_t nfft) {
	for (uint32_t k = 0; k < count; k++) {
		size_t length = CFG;
		kiss_fft_alloc((int)nfft, 0, (char *)mem + (size_t)k * CFG, &length);
	}
}
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	kiss_fft((kiss_fft_cfg)r->aux, (const kiss_fft_cpx *)r->in, (kiss_fft_cpx *)DATA(out));
	W32(out, 1);
}
#elif defined(K_KFFTR)
#include "kiss_fftr.h"
void setup(void *mem, uint32_t count, uint32_t nfft) {
	for (uint32_t k = 0; k < count; k++) {
		size_t length = CFG;
		kiss_fftr_alloc((int)nfft, 0, (char *)mem + (size_t)k * CFG, &length);
	}
}
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	kiss_fftr((kiss_fftr_cfg)r->aux, (const kiss_fft_scalar *)r->in, (kiss_fft_cpx *)DATA(out));
	W32(out, 1);
}
#elif defined(K_AESE) || defined(K_AESD) || defined(K_AESCTR)
#include "aes.h"
#ifdef SHARED
static struct AES_ctx context;
#endif
NOINLINE static void one(const rec_t *r, uint8_t *out) {
#if defined(CTXARENA)
	struct AES_ctx *ctx = (struct AES_ctx *)r->arena;
#define context (*ctx)
#elif !defined(SHARED)
	struct AES_ctx context;
#endif
	AES_init_ctx_iv(&context, (const uint8_t *)r->aux, (const uint8_t *)r->aux + 16);
	memcpy(DATA(out), (const void *)r->in, r->len);
#if defined(K_AESE)
	AES_CBC_encrypt_buffer(&context, DATA(out), r->len);
#elif defined(K_AESD)
	AES_CBC_decrypt_buffer(&context, DATA(out), r->len);
#else
	AES_CTR_xcrypt_buffer(&context, DATA(out), r->len);
#endif
	W32(out, r->len);
}
#elif defined(K_XXH32)
#include "xxhash.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) { W32(out, XXH32((const void *)r->in, r->len, 0)); }
#elif defined(K_XXH64)
#include "xxhash.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) { W64(out, XXH64((const void *)r->in, r->len, 0)); }
#elif defined(K_XXH3)
#include "xxhash.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) { W64(out, XXH3_64bits((const void *)r->in, r->len)); }
#elif defined(K_QOIE)
#define QOI_IMPLEMENTATION
#define QOI_NO_STDIO
#include "qoi.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	qoi_desc desc = {DIM, DIM, 4, QOI_SRGB};
	int length = 0;
	bump_set((void *)r->arena, ARENA);
	void *data = qoi_encode((const void *)r->in, &desc, &length);
	if (!data) {
		W32(out, -1);
		return;
	}
	memcpy(DATA(out), data, length);
	free(data);
	W32(out, length);
}
#elif defined(K_QOID)
#define QOI_IMPLEMENTATION
#define QOI_NO_STDIO
#include "qoi.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	qoi_desc desc;
	bump_set((void *)r->arena, ARENA);
	void *data = qoi_decode((const void *)r->in, (int)r->len, &desc, 4);
	if (!data) {
		W32(out, -1);
		return;
	}
	memcpy(DATA(out), data, DIM * DIM * 4);
	free(data);
	W32(out, DIM * DIM * 4);
}
#elif defined(K_SHA256)
#include "sha256.h"
#ifdef SHARED
static SHA256_CTX context;
#endif
NOINLINE static void one(const rec_t *r, uint8_t *out) {
#ifndef SHARED
	SHA256_CTX context;
#endif
	sha256_init(&context);
	sha256_update(&context, (const BYTE *)r->in, r->len);
	sha256_final(&context, DATA(out));
	W32(out, 32);
}
#elif defined(K_SHA1)
#include "sha1.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	SHA1_CTX context;
	sha1_init(&context);
	sha1_update(&context, (const BYTE *)r->in, r->len);
	sha1_final(&context, DATA(out));
	W32(out, 20);
}
#elif defined(K_MD5)
#include "md5.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
#ifdef CTXARENA
	MD5_CTX *ctx = (MD5_CTX *)r->arena;
#define context (*ctx)
#else
	MD5_CTX context;
#endif
	md5_init(&context);
	md5_update(&context, (const BYTE *)r->in, r->len);
	md5_final(&context, DATA(out));
	W32(out, 16);
#undef context
}
#elif defined(K_BROTLIE)
#include "brotli/encode.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t size = SLOT - 32;
	bump_set((void *)r->arena, ARENA);
	int status = BrotliEncoderCompress(QUALITY, LGWIN, BROTLI_MODE_GENERIC, r->len,
		(const uint8_t *)r->in, &size, DATA(out));
	W32(out, status ? size : 0);
}
#elif defined(K_BROTLID)
#include "brotli/decode.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t size = SLOT - 32;
	bump_set((void *)r->arena, ARENA);
	int status = BrotliDecoderDecompress(r->len, (const uint8_t *)r->in, &size, DATA(out));
	W32(out, status == BROTLI_DECODER_RESULT_SUCCESS ? size : 0);
}
#elif defined(K_WYHASH)
#include "wyhash.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) { W64(out, wyhash((const void *)r->in, r->len, 0, _wyp)); }
#elif defined(K_BLAKE2B)
#include "blake2.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	W32(out, blake2b(DATA(out), 64, (const void *)r->in, r->len, 0, 0) ? 0 : 64);
}
#elif defined(K_QOAE)
#define QOA_IMPLEMENTATION
#define QOA_NO_STDIO
#include "qoa.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	qoa_desc desc = {.channels = 2, .samplerate = 44100, .samples = r->len / 4};
	unsigned int length = 0;
	bump_set((void *)r->arena, ARENA);
	void *data = qoa_encode((const short *)r->in, &desc, &length);
	if (!data) {
		W32(out, 0);
		return;
	}
	memcpy(DATA(out), data, length);
	free(data);
	W32(out, length);
}
#elif defined(K_QOAD)
#define QOA_IMPLEMENTATION
#define QOA_NO_STDIO
#include "qoa.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	qoa_desc desc;
	bump_set((void *)r->arena, ARENA);
	short *data = qoa_decode((const unsigned char *)r->in, (int)r->len, &desc);
	if (!data) {
		W32(out, 0);
		return;
	}
	uint32_t length = desc.samples * desc.channels * 2;
	memcpy(DATA(out), data, length);
	free(data);
	W32(out, length);
}
#elif defined(K_YYJSON)
#include "yyjson.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set((void *)r->arena, ARENA);
	yyjson_doc *doc = yyjson_read((const char *)r->in, r->len, 0);
	if (!doc) {
		W32(out, 0);
		return;
	}
	W32(out + 4, yyjson_doc_get_read_size(doc));
	W32(out, yyjson_doc_get_val_count(doc));
	yyjson_doc_free(doc);
}
#elif defined(K_MD4C)
#include "md4c-html.h"
typedef struct {
	uint8_t *dst;
	uint32_t used;
} sink_t;
static void emit(const MD_CHAR *text, MD_SIZE size, void *user) {
	sink_t *sink = (sink_t *)user;
	if (sink->used + size <= SLOT - 32) memcpy(sink->dst + sink->used, text, size);
	sink->used += size;
}
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	sink_t sink = {DATA(out), 0};
	bump_set((void *)r->arena, ARENA);
	int status = md_html((const MD_CHAR *)r->in, r->len, emit, &sink, MD_DIALECT_GITHUB, 0);
	W32(out + 4, status);
	W32(out, status ? 0 : sink.used);
}
#elif defined(K_M6502)
#define CHIPS_IMPL
#include "m6502.h"
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	m6502_t cpu;
	uint8_t *ram = (uint8_t *)r->aux;
	memset(&cpu, 0, sizeof(cpu));
	uint64_t pins = m6502_init(&cpu, &(m6502_desc_t){0});
	for (uint32_t i = 0; i < CYCLES; i++) {
		pins = m6502_tick(&cpu, pins);
		uint16_t address = M6502_GET_ADDR(pins);
		if (pins & M6502_RW) {
			M6502_SET_DATA(pins, ram[address]);
		} else {
			ram[address] = M6502_GET_DATA(pins);
		}
	}
	W32(out, m6502_x(&cpu));
}
#else
#error kernel
#endif

uint32_t bulk(const rec_t *table, uint32_t n, uint8_t *out) {
	for (uint32_t i = 0; i < n; i++) one(table + i, out + (uintptr_t)i * SLOT);
	return n;
}

NOINLINE static void chunk(const rec_t *table, uint32_t n, uint8_t *out) {
	for (uint32_t i = 0; i < n; i++) one(table + i, out + (uintptr_t)i * SLOT);
}

/* the same records as bulk, cut into straight-line calls of k records each */
uint32_t bulk_chunks(const rec_t *table, uint32_t n, uint8_t *out, uint32_t k) {
	for (uint32_t i = 0; i < n; i += k)
		chunk(table + i, n - i < k ? n - i : k, out + (uintptr_t)i * SLOT);
	return n;
}
