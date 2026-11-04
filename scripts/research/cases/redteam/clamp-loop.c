#include <stdint.h>

uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	
	for (uint32_t k = 0; k < length; k++) { uint32_t s = state, b = input[k]; s = s > 0xfffffff0u ? 0u : s + b; state = s; }
	
	return state;
}
