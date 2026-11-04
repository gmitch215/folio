#include <stdint.h>
uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	if (length == 0) return state; do { state ^= (state << 3) ^ *input++; } while (--length); return state;
}
