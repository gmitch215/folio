#include <stdint.h>
uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	for (uint32_t k = 0; k < length; k++) state ^= input[k]; for (uint32_t k = 0; k < length; k++) state = (state << 1) ^ input[k]; return state;
}
