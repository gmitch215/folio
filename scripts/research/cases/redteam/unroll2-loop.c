#include <stdint.h>
uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	uint32_t k = 0; for (; k + 1 < length; k += 2) { state ^= input[k]; state = (state << 1) ^ (state >> 31); state ^= input[k + 1]; state = (state << 1) ^ (state >> 31); } if (k < length) { state ^= input[k]; state = (state << 1) ^ (state >> 31); } return state;
}
