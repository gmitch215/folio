#include <stdint.h>

__attribute__((export_name("read"))) uint32_t read_word(uint32_t address) {
	return *(uint32_t *)(uintptr_t)address;
}

__attribute__((export_name("write"))) void write_word(uint32_t address, uint32_t value) {
	*(uint32_t *)(uintptr_t)address = value;
}

__attribute__((export_name("add"))) uint32_t atomic_add(uint32_t address, uint32_t value) {
	return __atomic_fetch_add((uint32_t *)(uintptr_t)address, value, __ATOMIC_SEQ_CST);
}
