#ifndef FINAL_DRIVER_HARNESS_H
#define FINAL_DRIVER_HARNESS_H

#include <stddef.h>
#include <stdint.h>

// wasm32 addresses are 32-bit; the native build needs pointer-sized fields.
#ifdef __wasm__
typedef uint32_t addr_t;
#else
typedef uintptr_t addr_t;
#endif

typedef struct {
	addr_t in;
	uint32_t len;
	addr_t aux;
	addr_t arena;
} rec_t;

#define NOINLINE __attribute__((noinline))
#define W32(p, v) (*(uint32_t *)(p) = (uint32_t)(v))
#define DATA(out) ((out) + 32)
#define P(x) ((void *)(uintptr_t)(x))

// each record allocates from its own ARENA-byte slice; native builds use the system malloc.
void bump_set(void *base, size_t size);

// input generators run in prepare and allocate from one extra GEN_ARENA slice after the record slices.
static uintptr_t gen_arena;

// dev default input: byte j of a record is (j * 13 + (j >> 7)) & 255.
static inline void raw_fill(uint8_t *dst, uint32_t len) {
	for (uint32_t j = 0; j < len; j++) dst[j] = (uint8_t)((j * 13 + (j >> 7)) & 255);
}

#endif
