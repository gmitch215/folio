#include <stdint.h>

__attribute__((noinline)) uint32_t transition(uint32_t s, uint32_t b) { s ^= b; for (int j = 0; j < 8; j++) s = (s >> 1) ^ (0xa001u & -(s & 1u)); return s; }
uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	for (uint32_t k = 0; k < length; k++) state = transition(state, input[k]);
	return state;
}
