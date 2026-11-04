#include <stdint.h>

uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	
	for (uint32_t k = 0; k < length; k++) { uint32_t s = state, b = input[k]; s ^= b; s = (s >> 1) ^ (0xedb88320u & -(s & 1u)); state = s; }
	{ uint32_t s = state; s ^= 0xffffffffu; state = s; }
	return state;
}
