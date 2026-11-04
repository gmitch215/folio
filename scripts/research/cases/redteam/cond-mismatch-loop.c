#include <stdint.h>

uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	uint32_t s = state; s = ~s; state = s;
	for (uint32_t k = 0; k < length; k++) { uint32_t s = state, b = input[k]; s ^= b; for (int j = 0; j < 8; j++) s = (s >> 1) ^ (0xedb88320u & -(s & 1u)); state = s; }
	
	return state;
}
