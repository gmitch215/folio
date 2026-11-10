#include <stdint.h>
#include <string.h>

#include "harness.h"
#include "mpack.h"

static uint64_t mix(uint64_t x) {
	x ^= x >> 33;
	x *= 0xff51afd7ed558ccdULL;
	x ^= x >> 33;
	return x;
}

// byte 0 picks the type, bytes 4..7 the count or byte length.
static uint32_t gen_track(uint32_t i, uint8_t *dst) {
	uint64_t x = mix((uint64_t)i + 1);
	memcpy(dst, &x, 8);
	return 8;
}

static const mpack_type_t types[4] = {
	mpack_type_str,
	mpack_type_bin,
	mpack_type_array,
	mpack_type_map,
};

#define GEN(i, dst) gen_track(i, dst)

// error, buffer use, and the first 32 bytes the writer produced.
static void put_writer(uint8_t *out, mpack_writer_t *w, const char *buf) {
	W32(out, (uint32_t)mpack_writer_error(w));
	W32(out + 4, (uint32_t)mpack_writer_buffer_used(w));
	memcpy(DATA(out), buf, 32);
}

#if defined(K_WRITER_TRACK_PUSH)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	const uint8_t *in = (const uint8_t *)P(r->in);
	uint32_t count;
	memcpy(&count, in + 4, 4);
	char buf[64];
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_writer_track_push(&w, types[in[0] & 3], count);
	W32(out, (uint32_t)mpack_writer_error(&w));
	W32(out + 4, (uint32_t)mpack_writer_buffer_used(&w));
}
#elif defined(K_WRITER_TRACK_BYTES)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	uint32_t count;
	memcpy(&count, (const uint8_t *)P(r->in) + 4, 4);
	char buf[64];
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_writer_track_bytes(&w, count);
	W32(out, (uint32_t)mpack_writer_error(&w));
	W32(out + 4, (uint32_t)mpack_writer_buffer_used(&w));
}
#elif defined(K_WRITER_INIT)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	(void)r;
	char buf[64] = {0};
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	put_writer(out, &w, buf);
}
#elif defined(K_WRITE_OBJECT_BYTES)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	const uint8_t *in = (const uint8_t *)P(r->in);
	char buf[64] = {0};
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_write_object_bytes(&w, (const char *)in, in[4] & 7);
	put_writer(out, &w, buf);
}
#elif defined(K_START_ARRAY)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	uint32_t count;
	memcpy(&count, (const uint8_t *)P(r->in) + 4, 4);
	char buf[64] = {0};
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_start_array(&w, count);
	put_writer(out, &w, buf);
}
#elif defined(K_START_MAP)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	uint32_t count;
	memcpy(&count, (const uint8_t *)P(r->in) + 4, 4);
	char buf[64] = {0};
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_start_map(&w, count);
	put_writer(out, &w, buf);
}
#elif defined(K_WRITE_STR)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	const uint8_t *in = (const uint8_t *)P(r->in);
	char buf[64] = {0};
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_write_str(&w, (const char *)in, in[4] & 7);
	put_writer(out, &w, buf);
}
#elif defined(K_WRITE_UTF8)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	const uint8_t *in = (const uint8_t *)P(r->in);
	char buf[64] = {0};
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_write_utf8(&w, (const char *)in, in[4] & 7);
	put_writer(out, &w, buf);
}
#elif defined(K_WRITE_BIN)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	const uint8_t *in = (const uint8_t *)P(r->in);
	char buf[64] = {0};
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_write_bin(&w, (const char *)in, in[4] & 7);
	put_writer(out, &w, buf);
}
#elif defined(K_START_STR)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	uint32_t count;
	memcpy(&count, (const uint8_t *)P(r->in) + 4, 4);
	char buf[64] = {0};
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_start_str(&w, count);
	put_writer(out, &w, buf);
}
#elif defined(K_START_BIN)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	uint32_t count;
	memcpy(&count, (const uint8_t *)P(r->in) + 4, 4);
	char buf[64] = {0};
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_start_bin(&w, count);
	put_writer(out, &w, buf);
}
#elif defined(K_WRITE_BYTES)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	const uint8_t *in = (const uint8_t *)P(r->in);
	char buf[64] = {0};
	mpack_writer_t w;
	mpack_writer_init(&w, buf, sizeof buf);
	mpack_write_bytes(&w, (const char *)in, in[4] & 7);
	put_writer(out, &w, buf);
}
#else
#error kernel
#endif

#include "loop.h"
