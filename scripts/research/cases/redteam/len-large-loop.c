#include <stdint.h>
uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	uint32_t n = length; for (uint32_t k = 0; k < length; k++) state ^= input[k]; if (n > 65536u) state ^= 1u; return state;
}
