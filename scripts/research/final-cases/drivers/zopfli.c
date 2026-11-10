#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "harness.h"
#include "zopfli.h"

static uint32_t raw_len(uint32_t i) { return 64 + (i * 37) % 704; }

static uint32_t gen_raw(uint32_t i, uint8_t *dst) {
	uint32_t len = raw_len(i);
	raw_fill(dst, len);
	return len;
}

#define GEN(i, dst) gen_raw(i, dst)

#if defined(K_ZOPFLI_COMPRESS)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	ZopfliOptions options;
	unsigned char *buf = NULL;
	size_t size = 0;
	bump_set(P(r->arena), ARENA);
	ZopfliInitOptions(&options);
	ZopfliCompress(&options, ZOPFLI_FORMAT_DEFLATE, P(r->in), r->len, &buf, &size);
	W32(out, size);
	if (buf && size <= SLOT - 32) memcpy(DATA(out), buf, size);
	free(buf);
}
#else
#error kernel
#endif

#include "loop.h"
