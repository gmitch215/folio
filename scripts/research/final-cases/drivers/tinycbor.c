#include <stdint.h>
#include <string.h>

#include "cbor.h"
#include "harness.h"

// a definite-length array of 1 to 12 items, alternating uints and text strings.
static uint32_t gen_cbor(uint32_t i, uint8_t *dst) {
	CborEncoder enc, arr;
	uint32_t count = 1 + (i * 37) % 12;
	cbor_encoder_init(&enc, dst, REC_CAP, 0);
	cbor_encoder_create_array(&enc, &arr, count);
	for (uint32_t j = 0; j < count; j++) {
		if (j % 2) cbor_encode_text_string(&arr, "text", 4);
		else cbor_encode_uint(&arr, i + j * 7);
	}
	cbor_encoder_close_container(&enc, &arr);
	return (uint32_t)cbor_encoder_get_buffer_size(&enc, dst);
}

static uint32_t raw_len(uint32_t i) { return 64 + (i * 37) % 960; }

static uint32_t gen_raw(uint32_t i, uint8_t *dst) {
	uint32_t len = raw_len(i);
	raw_fill(dst, len);
	return len;
}

#if defined(K_PARSER_INIT)
#define GEN(i, dst) gen_cbor(i, dst)
#else
#define GEN(i, dst) gen_raw(i, dst)
#endif

#if defined(K_ENCODER_INIT)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	uint64_t v = 0;
	memcpy(&v, P(r->in), r->len < 8 ? r->len : 8);
	CborEncoder enc;
	cbor_encoder_init(&enc, DATA(out), SLOT - 32, 0);
	W32(out, cbor_encode_uint(&enc, v));
	W32(out + 4, cbor_encoder_get_buffer_size(&enc, DATA(out)));
}
#elif defined(K_ENCODE_TEXT_STRING)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	CborEncoder enc;
	cbor_encoder_init(&enc, DATA(out), SLOT - 32, 0);
	W32(out, cbor_encode_text_string(&enc, (const char *)P(r->in), r->len));
	W32(out + 4, cbor_encoder_get_buffer_size(&enc, DATA(out)));
}
#elif defined(K_ENCODE_BYTE_STRING)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	CborEncoder enc;
	cbor_encoder_init(&enc, DATA(out), SLOT - 32, 0);
	W32(out, cbor_encode_byte_string(&enc, (const uint8_t *)P(r->in), r->len));
	W32(out + 4, cbor_encoder_get_buffer_size(&enc, DATA(out)));
}
#elif defined(K_ENCODE_RAW)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	CborEncoder enc;
	cbor_encoder_init(&enc, DATA(out), SLOT - 32, 0);
	W32(out, cbor_encode_raw(&enc, (const uint8_t *)P(r->in), r->len));
	W32(out + 4, cbor_encoder_get_buffer_size(&enc, DATA(out)));
}
#elif defined(K_CREATE_ARRAY)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	const uint8_t *in = (const uint8_t *)P(r->in);
	uint32_t count = r->len & 15;
	CborEncoder parent, arr;
	cbor_encoder_init(&parent, DATA(out), SLOT - 32, 0);
	CborError err = cbor_encoder_create_array(&parent, &arr, count);
	for (uint32_t j = 0; j < count && !err; j++) err = cbor_encode_uint(&arr, in[j]);
	if (!err) err = cbor_encoder_close_container(&parent, &arr);
	W32(out, err);
	W32(out + 4, cbor_encoder_get_buffer_size(&parent, DATA(out)));
}
#elif defined(K_CREATE_MAP)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	const uint8_t *in = (const uint8_t *)P(r->in);
	uint32_t pairs = r->len & 7;
	CborEncoder parent, map;
	cbor_encoder_init(&parent, DATA(out), SLOT - 32, 0);
	CborError err = cbor_encoder_create_map(&parent, &map, pairs);
	for (uint32_t j = 0; j < pairs && !err; j++) {
		err = cbor_encode_uint(&map, j);
		if (!err) err = cbor_encode_uint(&map, in[j]);
	}
	if (!err) err = cbor_encoder_close_container(&parent, &map);
	W32(out, err);
	W32(out + 4, cbor_encoder_get_buffer_size(&parent, DATA(out)));
}
#elif defined(K_PARSER_INIT)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	CborParser parser;
	CborValue it;
	CborError err = cbor_parser_init(P(r->in), r->len, 0, &parser, &it);
	W32(out, err);
	W32(out + 4, 0);
	W32(out + 8, 0);
	if (!err) {
		W32(out + 4, cbor_value_validate_basic(&it));
		W32(out + 8, cbor_value_get_type(&it));
	}
}
#else
#error kernel
#endif

#include "loop.h"
