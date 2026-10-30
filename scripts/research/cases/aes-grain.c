#include <stdint.h>
#include <string.h>
#include "aes.c"

extern unsigned char input[65536], output[262144], encoded[262144];
void corpus_reset(void);

#define GRAIN_BLOCKS 288

static struct AES_ctx context;
static uint8_t iv0[AES_BLOCKLEN];

/* out-of-place CBC decrypt of blocks [first, first + count); depends on in[first - 1] only */
uint32_t decrypt_grain(const struct AES_ctx *ctx, const uint8_t *iv, const uint8_t *in,
	uint8_t *out, uint32_t first, uint32_t count) {
	const uint8_t *prev = first ? in + (first - 1) * AES_BLOCKLEN : iv;
	for (uint32_t i = first; i < first + count; i++) {
		const uint8_t *block = in + i * AES_BLOCKLEN;
		uint8_t *plain = out + i * AES_BLOCKLEN;
		memcpy(plain, block, AES_BLOCKLEN);
		InvCipher((state_t *)plain, (uint8_t *)ctx->RoundKey);
		XorWithIv(plain, (uint8_t *)prev);
		prev = block;
	}
	return count * AES_BLOCKLEN;
}

void initialize(void) {
	corpus_reset();
	AES_init_ctx_iv(&context, input + 64, input + 96);
	memcpy(iv0, input + 96, AES_BLOCKLEN);
	memcpy(encoded, input, 65536);
	AES_CBC_encrypt_buffer(&context, encoded, 65536);
}

uint32_t run_range(uint32_t first, uint32_t count) {
	return decrypt_grain(&context, iv0, encoded, output, first, count);
}

int entry(void) {
	for (uint32_t first = 0; first < 4096; first += GRAIN_BLOCKS) {
		uint32_t count = 4096 - first < GRAIN_BLOCKS ? 4096 - first : GRAIN_BLOCKS;
		run_range(first, count);
	}
	return 65536;
}

#ifdef GRAIN_DIFF
static uint8_t key[AES_KEYLEN], civ[AES_BLOCKLEN];
static uint8_t cipher[65536], scratch[65536];
uint32_t diff_key(void) { return (uint32_t)(uintptr_t)key; }
uint32_t diff_iv(void) { return (uint32_t)(uintptr_t)civ; }
uint32_t diff_cipher(void) { return (uint32_t)(uintptr_t)cipher; }
uint32_t diff_scratch(void) { return (uint32_t)(uintptr_t)scratch; }
uint32_t diff_output(void) { return (uint32_t)(uintptr_t)output; }

/* the unmodified upstream function, in place on scratch */
uint32_t diff_original(uint32_t length) {
	struct AES_ctx c;
	AES_init_ctx_iv(&c, key, civ);
	memcpy(scratch, cipher, length);
	AES_CBC_decrypt_buffer(&c, scratch, length);
	return length;
}

/* the variant, grains run last to first so any hidden dependency shows */
uint32_t diff_variant(uint32_t length, uint32_t grain) {
	struct AES_ctx c;
	AES_init_ctx_iv(&c, key, civ);
	uint32_t blocks = length / AES_BLOCKLEN, total = 0;
	uint32_t groups = (blocks + grain - 1) / grain;
	for (uint32_t g = groups; g > 0; g--) {
		uint32_t first = (g - 1) * grain;
		uint32_t count = blocks - first < grain ? blocks - first : grain;
		total += decrypt_grain(&c, civ, cipher, output, first, count);
	}
	return total;
}
#endif
