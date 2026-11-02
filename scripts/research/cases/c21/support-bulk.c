#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static unsigned char *region;
static size_t limit;
static size_t cursor;

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
void bump_set(void *base, size_t size) {
	region = (unsigned char *)base;
	limit = size;
	cursor = 0;
}
void *malloc(size_t size) {
	size_t start = (cursor + 31) & ~(size_t)15;
	if (start > limit || size > limit - start) return 0;
	((size_t *)(region + start))[-1] = size;
	cursor = start + size;
	return region + start;
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
