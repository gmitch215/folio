#include <stdint.h>
#include "lz4.h"

/* table: n pairs of u32 (offset, length); slot i of out holds capacity bytes; the sizes follow */
uint32_t compress_all(const uint32_t *table, uint32_t n, uint8_t *out, uint32_t capacity) {
	uint32_t *sizes = (uint32_t *)(out + (uintptr_t)n * capacity);
	uint32_t total = 0;
	for (uint32_t i = 0; i < n; i++) {
		int size = LZ4_compress_default(
			(const char *)(uintptr_t)table[2 * i],
			(char *)(out + (uintptr_t)i * capacity),
			(int)table[2 * i + 1],
			(int)capacity
		);
		sizes[i] = (uint32_t)size;
		total += (uint32_t)size;
	}
	return total;
}

#ifdef SLOT
#ifndef SIZE_STRIDE
#define SIZE_STRIDE 1
#endif

/* the same loop with a fixed slot size and no running total; the host sums the size table */
uint32_t compress_slots(const uint32_t *table, uint32_t n, uint8_t *out) {
	uint32_t *sizes = (uint32_t *)(out + (uintptr_t)n * SLOT);
	for (uint32_t i = 0; i < n; i++)
		sizes[SIZE_STRIDE * i] = (uint32_t)LZ4_compress_default(
			(const char *)(uintptr_t)table[2 * i],
			(char *)(out + (uintptr_t)i * SLOT),
			(int)table[2 * i + 1],
			SLOT
		);
	return n;
}
#endif
