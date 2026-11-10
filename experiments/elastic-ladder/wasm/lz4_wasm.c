#define LZ4_FREESTANDING 1
#define LZ4_memset __builtin_memset
#define LZ4_memcpy __builtin_memcpy
#define LZ4_memmove __builtin_memmove
#include "lz4.c"

/* explicit visibility; wasm-ld --export-dynamic drops plain functions with no attribute. */
#define WASM_EXPORT __attribute__((visibility("default")))

WASM_EXPORT int bound(int n) { return LZ4_compressBound(n); }

WASM_EXPORT int compress_at(const char *src, int n, char *dst, int cap) {
	return LZ4_compress_default(src, dst, n, cap);
}

WASM_EXPORT int decompress_at(const char *src, int csize, char *dst, int osize) {
	return LZ4_decompress_safe(src, dst, csize, osize);
}

WASM_EXPORT void copy_bytes(unsigned char *dst, const unsigned char *src, unsigned n) {
	__builtin_memcpy(dst, src, n);
}
