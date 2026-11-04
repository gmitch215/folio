#include <stdint.h>
uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	const uint8_t *end = input + length; while (input != end) state = ((state << 1) | (state >> 31)) ^ *input++; return state;
}
