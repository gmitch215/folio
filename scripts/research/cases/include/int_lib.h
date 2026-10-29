#pragma once
#include <stdint.h>
#include <limits.h>
#define CRT_HAS_128BIT
#define COMPILER_RT_ABI
typedef int64_t di_int;
typedef uint64_t du_int;
typedef __int128 ti_int;
typedef union {
	ti_int all;
	struct { du_int low; di_int high; } s;
} twords;
