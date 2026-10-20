#include <stdint.h>

static uint32_t kernel(uint32_t address, uint32_t rounds) {
	uint32_t *word = (uint32_t *)(uintptr_t)address;
	uint32_t value = *word;
	for (uint32_t i = 0; i < rounds; i++) {
		value ^= value << 13;
		value ^= value >> 17;
		value ^= value << 5;
	}
	*word = value;
	return value;
}

/* The return value is carried on the original Wasm stack, without a reduction API. */
__attribute__((export_name("main")))
uint32_t program(uint32_t address, uint32_t count, uint32_t rounds) {
	uint32_t sum = 7;
	for (uint32_t i = 0; i < count; i++) {
		if (i & 1) kernel(address + i * 4, rounds);
		else kernel(address + i * 4, rounds + 1);
		sum += i * 3;
	}
	return sum;
}
