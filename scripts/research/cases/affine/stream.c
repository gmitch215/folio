#include <stdint.h>

__attribute__((noinline))
uint32_t transition(uint32_t state, uint32_t byte) {
	state ^= byte;
	for (uint32_t k = 0; k < 8; k++)
		state = (state >> 1) ^ (0x82f63b78u & -(state & 1u));
	return state;
}

uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	for (uint32_t k = 0; k < length; k++) state = transition(state, input[k]);
	return state;
}
