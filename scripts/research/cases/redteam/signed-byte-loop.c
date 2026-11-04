#include <stdint.h>
uint32_t update(uint32_t state, const uint8_t *input, uint32_t length) {
	const int8_t *p = (const int8_t *)input; for (uint32_t k = 0; k < length; k++) state ^= (uint32_t)(int32_t)p[k]; return state;
}
