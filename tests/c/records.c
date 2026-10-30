#include <stdint.h>

/* table: n pairs of u32 (offset, length); out: 32 bytes per record */
__attribute__((noinline)) static void digest_one(const uint32_t *entry, uint8_t *out) {
	const uint8_t *data = (const uint8_t *)(uintptr_t)entry[0];
	uint32_t length = entry[1];
	uint64_t lanes[4] = {0x9e3779b97f4a7c15ull, 0xbf58476d1ce4e5b9ull, 0x94d049bb133111ebull, length};
	for (uint32_t i = 0; i < length; i++) {
		uint64_t lane = lanes[i & 3] ^ data[i];
		lane *= 0x100000001b3ull;
		lanes[i & 3] = (lane << 13) | (lane >> 51);
	}
	for (uint32_t i = 0; i < 4; i++)
		for (uint32_t b = 0; b < 8; b++) out[8 * i + b] = (uint8_t)(lanes[i] >> (8 * b));
}

__attribute__((export_name("digest_all"))) uint32_t digest_all(const uint32_t *table, uint32_t n, uint8_t *out) {
	for (uint32_t i = 0; i < n; i++) digest_one(table + 2 * i, out + 32 * i);
	return n;
}
