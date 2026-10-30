#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifndef CORPUS_ARENA_BYTES
#define CORPUS_ARENA_BYTES (4 * 1024 * 1024)
#endif
static unsigned char arena[CORPUS_ARENA_BYTES] __attribute__((aligned(16)));
static size_t cursor;
unsigned char input[65536];
unsigned char output[262144];
unsigned char encoded[262144];
int encoded_size;

#ifdef FOLIO_CORPUS_INPUTS
static unsigned input_seed;
void corpus_set_seed(unsigned value) { input_seed = value; }
unsigned corpus_seed(void) { return input_seed; }
#endif

void *memcpy(void *dst, const void *src, size_t count) {
	for (size_t i = 0; i < count; i++) ((unsigned char *)dst)[i] = ((const unsigned char *)src)[i];
	return dst;
}
void *memmove(void *dst, const void *src, size_t count) {
	if ((uintptr_t)dst <= (uintptr_t)src) return memcpy(dst, src, count);
	for (size_t i = count; i; i--) ((unsigned char *)dst)[i - 1] = ((const unsigned char *)src)[i - 1];
	return dst;
}
void *memset(void *dst, int value, size_t count) {
	for (size_t i = 0; i < count; i++) ((unsigned char *)dst)[i] = value;
	return dst;
}
int memcmp(const void *a, const void *b, size_t count) {
	for (size_t i = 0; i < count; i++) {
		int d = ((const unsigned char *)a)[i] - ((const unsigned char *)b)[i];
		if (d) return d;
	}
	return 0;
}
size_t strlen(const char *value) {
	size_t length = 0;
	while (value[length]) length++;
	return length;
}
void *malloc(size_t size) {
	size_t start = (cursor + 31) & ~(size_t)15;
	if (start > sizeof(arena) || size > sizeof(arena) - start) return 0;
	((size_t *)(arena + start))[-1] = size;
	cursor = start + size;
	return arena + start;
}
void free(void *ptr) { (void)ptr; }
void *calloc(size_t count, size_t size) {
	if (size && count > (size_t)-1 / size) return 0;
	void *ptr = malloc(count * size);
	if (ptr) memset(ptr, 0, count * size);
	return ptr;
}
void *realloc(void *ptr, size_t size) {
	void *next = malloc(size);
	if (ptr && next) {
		size_t old = ((size_t *)ptr)[-1];
		memcpy(next, ptr, old < size ? old : size);
	}
	return next;
}
void abort(void) { __builtin_trap(); }
int abs(int value) { return value < 0 ? -value : value; }
void corpus_reset(void) {
	cursor = 0;
	memset(arena, 0, sizeof(arena));
	memset(output, 0, sizeof(output));
	memset(encoded, 0, sizeof(encoded));
	encoded_size = 0;
	for (unsigned i = 0; i < sizeof(input); i++) {
		unsigned value = i * 13 + (i >> 7);
#ifdef FOLIO_CORPUS_INPUTS
		if (input_seed == 1) value = 0;
		else if (input_seed == 2) { value ^= 0x9e3779b9u; value ^= value << 13; value ^= value >> 17; value ^= value << 5; }
		else if (input_seed == 3) value = (i / 257) & 255;
		else if (input_seed == 4) value = 255;
#endif
		input[i] = value & 255;
	}
}
unsigned corpus_output(void) { return (unsigned)(uintptr_t)output; }
