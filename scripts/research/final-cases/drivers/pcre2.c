#include <stdint.h>
#include <string.h>

#include "harness.h"
#include "pcre2posix.h"

#define PATTERN "([a-z]+)([0-9]+)"

static uint64_t mix(uint64_t x) {
	x ^= x >> 33;
	x *= 0xff51afd7ed558ccdULL;
	x ^= x >> 33;
	return x;
}

// a NUL-terminated subject of letters, digits and spaces; the NUL is part of the record.
static uint32_t gen_subject(uint32_t i, uint8_t *dst) {
	uint32_t n = 8 + (i * 37) % 120;
	for (uint32_t j = 0; j < n; j++) {
		uint64_t x = mix((uint64_t)i * 256 + j);
		switch (x % 3) {
		case 0:
			dst[j] = (uint8_t)('a' + (x >> 8) % 26);
			break;
		case 1:
			dst[j] = (uint8_t)('0' + (x >> 8) % 10);
			break;
		default:
			dst[j] = ' ';
			break;
		}
	}
	dst[n] = 0;
	return n + 1;
}

// byte 0 picks the error code, 1 to 17.
static uint32_t gen_code(uint32_t i, uint8_t *dst) {
	uint64_t x = mix((uint64_t)i + 1);
	memcpy(dst, &x, 8);
	return 8;
}

#if defined(K_REGEXEC)
#define GEN(i, dst) gen_subject(i, dst)
#elif defined(K_REGERROR)
#define GEN(i, dst) gen_code(i, dst)
#else
#error kernel
#endif

#if defined(K_REGEXEC)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	regex_t re;
	if (pcre2_regcomp(&re, PATTERN, REG_EXTENDED) != 0) {
		W32(out, 0xffffffffu);
		return;
	}
	regmatch_t m[3] = {{-1, -1}, {-1, -1}, {-1, -1}};
	int e = pcre2_regexec(&re, (const char *)P(r->in), 3, m, 0);
	W32(out, (uint32_t)e);
	for (int g = 0; g < 3; g++) {
		W32(out + 4 + 8 * g, (uint32_t)m[g].rm_so);
		W32(out + 8 + 8 * g, (uint32_t)m[g].rm_eo);
	}
}
#elif defined(K_REGERROR)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	regex_t re;
	if (pcre2_regcomp(&re, PATTERN, REG_EXTENDED) != 0) {
		W32(out, 0xffffffffu);
		return;
	}
	int code = 1 + (int)(((const uint8_t *)P(r->in))[0] % 17);
	size_t n = pcre2_regerror(code, &re, (char *)DATA(out), SLOT - 32);
	W32(out, (uint32_t)n);
}
#endif

#include "loop.h"
