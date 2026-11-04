#include <stdint.h>
uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	while (length >= 4) { state ^= *(const uint32_t *)input; input += 4; length -= 4; } while (length--) state ^= *input++; return state;
}
