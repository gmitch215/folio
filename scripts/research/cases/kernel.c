#include <stdint.h>
#include <string.h>
#include <stdlib.h>

extern unsigned char input[65536], output[262144], encoded[262144];
extern int encoded_size;
void corpus_reset(void);
#ifdef FOLIO_CORPUS_INPUTS
unsigned corpus_seed(void);
#endif

#if defined(CORPUS_LZ4)
#include "lz4.h"
void initialize(void) {
	corpus_reset();
	encoded_size = LZ4_compress_default((char *)input, (char *)encoded, 65536, 262144);
}
int entry(void) {
#if CASE == 1
	return LZ4_compress_default((char *)input, (char *)output, 65536, 262144);
#else
	return LZ4_decompress_safe((char *)encoded, (char *)output, encoded_size, 65536);
#endif
}
#elif defined(CORPUS_MINIZ)
#include "miniz.h"
void initialize(void) {
	corpus_reset();
	mz_ulong size = 262144;
	if (mz_compress(encoded, &size, input, 65536) != MZ_OK) abort();
	encoded_size = size;
}
unsigned entry(void) {
#if CASE == 1
	mz_ulong size = 262144;
	int status = mz_compress(output, &size, input, 65536);
	return status ? (unsigned)status : size;
#elif CASE == 2
	mz_ulong size = 262144;
	int status = mz_uncompress(output, &size, encoded, encoded_size);
	return status ? (unsigned)status : size;
#elif CASE == 3
	return mz_crc32(0, input, 65536);
#else
	return mz_adler32(1, input, 65536);
#endif
}
#elif defined(CORPUS_JSMN)
#include "jsmn.h"
static jsmn_parser parser;
static jsmntok_t tokens[4096];
static unsigned length;
void initialize(void) {
	corpus_reset();
	const char json[] = "{\"items\":[1,2,3],\"valid\":true,\"text\":\"hello\"}";
	input[0] = '[';
	length = 1;
	unsigned objects = 256;
#ifdef FOLIO_CORPUS_INPUTS
	objects = 128 + (corpus_seed() % 3) * 64;
#endif
	for (unsigned i = 0; i < objects; i++) {
		if (i) input[length++] = ',';
		memcpy(input + length, json, sizeof(json) - 1);
		length += sizeof(json) - 1;
	}
	input[length++] = ']';
	jsmn_init(&parser);
	memset(tokens, 0, sizeof(tokens));
}
int entry(void) { return jsmn_parse(&parser, (char *)input, length, tokens, 4096); }
#elif defined(CORPUS_KISSFFT)
#include "kiss_fft.h"
#include "kiss_fftr.h"
static kiss_fft_cfg complex_config;
static kiss_fftr_cfg real_config;
void initialize(void) {
	corpus_reset();
#if CASE == 1
	complex_config = kiss_fft_alloc(1024, 0, 0, 0);
#else
	real_config = kiss_fftr_alloc(1024, 0, 0, 0);
#endif
	float *values = (float *)input;
	for (unsigned i = 0; i < 2048; i++) {
		unsigned phase = 0;
#ifdef FOLIO_CORPUS_INPUTS
		phase = corpus_seed() * 7;
#endif
		values[i] = (float)((int)((i + phase) % 31) - 15) / 16;
	}
}
int entry(void) {
#if CASE == 1
	kiss_fft(complex_config, (kiss_fft_cpx *)input, (kiss_fft_cpx *)output);
#else
	kiss_fftr(real_config, (float *)input, (kiss_fft_cpx *)output);
#endif
	return 1024;
}
#elif defined(CORPUS_AES)
#include "aes.h"
static struct AES_ctx context;
void initialize(void) {
	corpus_reset();
	AES_init_ctx_iv(&context, input + 64, input + 96);
	memcpy(output, input, 65536);
#if CASE == 2
	AES_CBC_encrypt_buffer(&context, output, 65536);
	AES_init_ctx_iv(&context, input + 64, input + 96);
#endif
}
int entry(void) {
#if CASE == 1
	AES_CBC_encrypt_buffer(&context, output, 65536);
#elif CASE == 2
	AES_CBC_decrypt_buffer(&context, output, 65536);
#else
	AES_CTR_xcrypt_buffer(&context, output, 65536);
#endif
	return 65536;
}
#elif defined(CORPUS_XXHASH)
#include "xxhash.h"
void initialize(void) { corpus_reset(); }
uint64_t entry(void) {
#if CASE == 1
	return XXH32(input, 65536, 0);
#elif CASE == 2
	return XXH64(input, 65536, 0);
#else
	return XXH3_64bits(input, 65536);
#endif
}
#elif defined(CORPUS_QOI)
#define QOI_IMPLEMENTATION
#define QOI_NO_STDIO
#include "qoi.h"
static qoi_desc desc;
void initialize(void) {
	corpus_reset();
	desc = (qoi_desc){128, 128, 4, QOI_SRGB};
	void *data = qoi_encode(input, &desc, &encoded_size);
	if (!data) abort();
	memcpy(encoded, data, encoded_size);
	free(data);
}
int entry(void) {
	void *data;
#if CASE == 1
	int length;
	data = qoi_encode(input, &desc, &length);
#else
	data = qoi_decode(encoded, encoded_size, &desc, 4);
	int length = 65536;
#endif
	if (!data) return -1;
	memcpy(output, data, length);
	free(data);
	return length;
}
#elif defined(CORPUS_CRYPTO)
#if CASE == 1
#include "sha256.h"
static SHA256_CTX context;
#elif CASE == 2
#include "sha1.h"
static SHA1_CTX context;
#else
#include "md5.h"
static MD5_CTX context;
#endif
void initialize(void) {
	corpus_reset();
#if CASE == 1
	sha256_init(&context);
#elif CASE == 2
	sha1_init(&context);
#else
	md5_init(&context);
#endif
}
int entry(void) {
#if CASE == 1
	sha256_update(&context, input, 65536);
	sha256_final(&context, output);
	return 32;
#elif CASE == 2
	sha1_update(&context, input, 65536);
	sha1_final(&context, output);
	return 20;
#else
	md5_update(&context, input, 65536);
	md5_final(&context, output);
	return 16;
#endif
}
#elif defined(CORPUS_CHIPS)
#define CHIPS_IMPL
#include "m6502.h"
static m6502_t cpu;
static uint64_t pins;
static unsigned char ram[65536];
void initialize(void) {
	corpus_reset();
	memset(&cpu, 0, sizeof(cpu));
	memset(ram, 0xea, sizeof(ram));
	ram[0xfffc] = 0;
	ram[0xfffd] = 2;
	ram[0x200] = 0xe8;
	ram[0x201] = 0x4c;
	ram[0x202] = 0;
	ram[0x203] = 2;
	pins = m6502_init(&cpu, &(m6502_desc_t){0});
}
int entry(void) {
	for (unsigned i = 0; i < 65536; i++) {
		pins = m6502_tick(&cpu, pins);
		uint16_t address = M6502_GET_ADDR(pins);
		if (pins & M6502_RW) {
			M6502_SET_DATA(pins, ram[address]);
		} else {
			ram[address] = M6502_GET_DATA(pins);
		}
	}
	return m6502_x(&cpu);
}
#endif
