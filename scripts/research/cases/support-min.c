#include <stdint.h>
#include <string.h>

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
