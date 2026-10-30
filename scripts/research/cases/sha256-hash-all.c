#include <stdint.h>
#include "sha256.h"

#ifndef HELPER
/* table: n pairs of u32 (offset, length); out: n * 32 bytes */
uint32_t sha256_all(const uint32_t *table, uint32_t n, uint8_t *out) {
	for (uint32_t i = 0; i < n; i++) {
		SHA256_CTX ctx;
		sha256_init(&ctx);
		sha256_update(&ctx, (const BYTE *)(uintptr_t)table[2 * i], table[2 * i + 1]);
		sha256_final(&ctx, out + 32 * i);
	}
	return n;
}
#else
/* the same loop with the per-input work in a helper; the route needs the table pointer step last */
__attribute__((noinline)) static void sha256_one(const uint32_t *entry, uint8_t *out) {
	SHA256_CTX ctx;
	sha256_init(&ctx);
	sha256_update(&ctx, (const BYTE *)(uintptr_t)entry[0], entry[1]);
	sha256_final(&ctx, out);
}

uint32_t sha256_all(const uint32_t *table, uint32_t n, uint8_t *out) {
	for (uint32_t i = 0; i < n; i++) sha256_one(table + 2 * i, out + 32 * i);
	return n;
}
#endif
