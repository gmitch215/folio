#include <stdint.h>

uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	
	for (uint32_t k = 0; k < length; k++) { uint32_t s = state, b = input[k]; s ^= (uint32_t)b << 24; for (int j = 0; j < 8; j++) s = (s << 1) ^ (0x04c11db7u & -(s >> 31)); state = s; }
	
	return state;
}
