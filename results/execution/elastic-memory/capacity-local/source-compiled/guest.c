#include <stdint.h>

uint32_t walk(uint32_t pages, uint32_t iterations) {
	uint32_t page = 0, checksum = 0;
	for (uint32_t i = 0; i < iterations; i++) {
		uint32_t *node = (uint32_t *)(uintptr_t)((page + 1u) * 65536u + 128u);
		uint32_t value = node[0];
		checksum = checksum * 31u ^ value;
		node[0] = value + 1u;
		page = node[1] % pages;
	}
	return checksum;
}
