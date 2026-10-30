#include <stdint.h>
#include "blake3.h"

/* table: n pairs of u32 (offset, length); out: n * 32 bytes */
uint32_t hash_all(const uint32_t *table, uint32_t n, uint8_t *out) {
	for (uint32_t i = 0; i < n; i++) {
		blake3_hasher hasher;
		blake3_hasher_init(&hasher);
		blake3_hasher_update(&hasher, (const void *)(uintptr_t)table[2 * i], table[2 * i + 1]);
		blake3_hasher_finalize(&hasher, out + 32 * i, BLAKE3_OUT_LEN);
	}
	return n;
}
