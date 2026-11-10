#include <stdint.h>
#include <string.h>

#include "harness.h"
#include "pb_decode.h"
#include "pb_encode.h"

static uint32_t raw_len(uint32_t i) { return 1 + (i * 37) % 1000; }

static uint32_t gen_raw(uint32_t i, uint8_t *dst) {
	uint32_t len = raw_len(i);
	raw_fill(dst, len);
	return len;
}

#define GEN(i, dst) gen_raw(i, dst)

#if defined(K_OSTREAM_FROM_BUFFER)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	uint64_t v = 0;
	memcpy(&v, P(r->in), r->len < 8 ? r->len : 8);
	pb_ostream_t s = pb_ostream_from_buffer(DATA(out), SLOT - 32);
	W32(out, pb_encode_varint(&s, v));
	W32(out + 4, s.bytes_written);
}
#elif defined(K_WRITE)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	pb_ostream_t s = pb_ostream_from_buffer(DATA(out), SLOT - 32);
	size_t n = r->len < SLOT - 32 ? r->len : SLOT - 32;
	W32(out, pb_write(&s, P(r->in), n));
	W32(out + 4, s.bytes_written);
}
#elif defined(K_ENCODE_STRING)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	pb_ostream_t s = pb_ostream_from_buffer(DATA(out), SLOT - 32);
	W32(out, pb_encode_string(&s, P(r->in), r->len));
	W32(out + 4, s.bytes_written);
}
#elif defined(K_ISTREAM_FROM_BUFFER)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	pb_istream_t s = pb_istream_from_buffer(P(r->in), r->len);
	uint64_t v = 0;
	W32(out, pb_decode_varint(&s, &v));
	W32(out + 4, (uint32_t)v);
	W32(out + 8, (uint32_t)s.bytes_left);
}
#elif defined(K_READ)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	pb_istream_t s = pb_istream_from_buffer(P(r->in), r->len);
	size_t n = r->len < SLOT - 32 ? r->len : SLOT - 32;
	W32(out, pb_read(&s, DATA(out), n));
	W32(out + 4, (uint32_t)s.bytes_left);
}
#else
#error kernel
#endif

#include "loop.h"
