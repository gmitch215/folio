#include <stdint.h>
uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	for (uint32_t k = 0; k < length; k++) if (input[k] > state) state = input[k]; return state;
}
