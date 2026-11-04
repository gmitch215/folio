#include <stdint.h>
uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	uint32_t prev = 0; for (uint32_t k = 0; k < length; k++) { state ^= input[k] ^ prev; prev = input[k]; } return state;
}
