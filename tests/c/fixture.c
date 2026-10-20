#include <stdint.h>

__attribute__((export_name("mix"))) uint32_t mix(uint32_t address, uint32_t rounds) {
	uint32_t *p = (uint32_t *)(uintptr_t)address;
	uint32_t x = *p;
	for (uint32_t j = 0; j < rounds; j++) {
		x ^= x << 13;
		x ^= x >> 17;
		x ^= x << 5;
	}
	*p = x;
	return x;
}

__attribute__((export_name("program"))) void program(uint32_t address, uint32_t count,
													 uint32_t rounds) {
	for (uint32_t i = 0; i < count; i++) {
		mix(address + i * 4, rounds);
	}
}

__attribute__((export_name("dependent_program"))) void dependent_program(uint32_t address,
																		 uint32_t count) {
	for (uint32_t i = 0; i < count; i++) {
		uint32_t *p = (uint32_t *)(uintptr_t)address;
		*p = p[-1] + 1;
		address += 4;
	}
}

__attribute__((export_name("aliased_program"))) void
aliased_program(uint32_t address, uint32_t count, uint32_t rounds) {
	for (uint32_t i = 0; i < count; i++) {
		mix(address, rounds);
		rounds++;
	}
}

__attribute__((noinline)) uint32_t divide(uint32_t address, uint32_t denominator) {
	uint32_t *p = (uint32_t *)(uintptr_t)address;
	*p = (*p + 1) / denominator;
	return *p;
}

__attribute__((export_name("division_program"))) void
division_program(uint32_t address, uint32_t count, uint32_t denominator) {
	for (uint32_t i = 0; i < count; i++) {
		divide(address + i * 4, denominator);
	}
}

__attribute__((export_name("increment"))) uint32_t increment(uint32_t address) {
	uint32_t *p = (uint32_t *)(uintptr_t)address;
	return ++*p;
}

__attribute__((export_name("copy_word"))) uint32_t copy_word(uint32_t destination,
															 uint32_t source) {
	uint32_t x = *(uint32_t *)(uintptr_t)source;
	*(uint32_t *)(uintptr_t)destination = x;
	return x;
}

__attribute__((export_name("trap_after_write"))) void trap_after_write(uint32_t address) {
	*(uint32_t *)(uintptr_t)address = 91;
	__builtin_trap();
}
