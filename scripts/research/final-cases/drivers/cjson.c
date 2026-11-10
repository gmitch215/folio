#include <stdint.h>
#include <string.h>

#include "cJSON.h"
#include "harness.h"

typedef struct {
	uint8_t *p;
	uint32_t n;
} wbuf;

static void put(wbuf *w, const char *s) {
	while (*s) w->p[w->n++] = (uint8_t)*s++;
}

static void put_uint(wbuf *w, uint32_t v) {
	char digits[12];
	int k = 0;
	do {
		digits[k++] = (char)('0' + v % 10);
		v /= 10;
	} while (v);
	while (k) w->p[w->n++] = (uint8_t)digits[--k];
}

// a JSON document with ints, strings, true, false and null; no fractions or exponents.
static uint32_t gen_json(uint32_t i, uint8_t *dst) {
	wbuf w = {dst, 0};
	uint32_t items = 4 + (i * 37) % 40;
	put(&w, "{\"id\":");
	put_uint(&w, i);
	put(&w, ",\"items\":[");
	for (uint32_t j = 0; j < items; j++) {
		if (j) put(&w, ",");
		switch ((i + j) % 4) {
		case 0:
			put_uint(&w, (i * 13 + j * 7) % 1000);
			break;
		case 1:
			put(&w, "\"str");
			put_uint(&w, j);
			put(&w, "\"");
			break;
		case 2:
			put(&w, "true");
			break;
		default:
			put(&w, "null");
			break;
		}
	}
	put(&w, "]}");
	return w.n;
}

static uint32_t gen_ints(uint32_t i, uint8_t *dst) {
	uint32_t count = 8 + (i * 37) % 120;
	for (uint32_t j = 0; j < count; j++) {
		int32_t v = (int32_t)((j * 13 + (j >> 7)) & 255) - 128;
		memcpy(dst + 4 * j, &v, 4);
	}
	return 4 * count;
}

// values are k / 4 with k in [-128, 127], exact in float and double.
static uint32_t gen_floats(uint32_t i, uint8_t *dst) {
	uint32_t count = 8 + (i * 37) % 60;
	for (uint32_t j = 0; j < count; j++) {
		float v = (float)((int)((j * 13 + (j >> 7)) & 255) - 128) / 4.0f;
		memcpy(dst + 4 * j, &v, 4);
	}
	return 4 * count;
}

static uint32_t gen_doubles(uint32_t i, uint8_t *dst) {
	uint32_t count = 8 + (i * 37) % 60;
	for (uint32_t j = 0; j < count; j++) {
		double v = (double)((int)((j * 13 + (j >> 7)) & 255) - 128) / 4.0;
		memcpy(dst + 8 * j, &v, 8);
	}
	return 8 * count;
}

// NUL-terminated strings, back to back.
static uint32_t gen_strings(uint32_t i, uint8_t *dst) {
	wbuf w = {dst, 0};
	uint32_t count = 1 + (i * 37) % 16;
	for (uint32_t j = 0; j < count; j++) {
		put(&w, "s");
		put_uint(&w, i);
		put(&w, "_");
		put_uint(&w, j);
		w.p[w.n++] = 0;
	}
	return w.n;
}

#if defined(K_CREATE_INT_ARRAY)
#define GEN(i, dst) gen_ints(i, dst)
#elif defined(K_CREATE_FLOAT_ARRAY)
#define GEN(i, dst) gen_floats(i, dst)
#elif defined(K_CREATE_DOUBLE_ARRAY)
#define GEN(i, dst) gen_doubles(i, dst)
#elif defined(K_CREATE_STRING_ARRAY)
#define GEN(i, dst) gen_strings(i, dst)
#else
#define GEN(i, dst) gen_json(i, dst)
#endif

// the printed text goes to DATA; word `at` holds its length, or all ones when it does not fit.
static void emit_text(uint8_t *out, uint32_t at, char *text) {
	size_t n = text ? strlen(text) : 0;
	if (!text || n > SLOT - 32) {
		W32(out + at, 0xffffffffu);
		return;
	}
	memcpy(DATA(out), text, n);
	W32(out + at, n);
}

#if defined(K_PARSE_WITH_LENGTH)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	cJSON *root = cJSON_ParseWithLength(P(r->in), r->len);
	W32(out, root != NULL);
	emit_text(out, 4, root ? cJSON_PrintUnformatted(root) : NULL);
}
#elif defined(K_PARSE_WITH_LENGTH_OPTS)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	const char *end = NULL;
	cJSON *root = cJSON_ParseWithLengthOpts(P(r->in), r->len, &end, 0);
	W32(out, root != NULL);
	W32(out + 8, end ? (uint32_t)(end - (const char *)P(r->in)) : 0xffffffffu);
	emit_text(out, 4, root ? cJSON_PrintUnformatted(root) : NULL);
}
#elif defined(K_PRINT_PREALLOCATED)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	char *buf = (char *)DATA(out);
	buf[0] = 0;
	cJSON *root = cJSON_ParseWithLength(P(r->in), r->len);
	W32(out, root != NULL && cJSON_PrintPreallocated(root, buf, SLOT - 32, 0));
	W32(out + 4, strlen(buf));
}
#elif defined(K_CREATE_INT_ARRAY)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	cJSON *arr = cJSON_CreateIntArray((const int *)P(r->in), (int)(r->len / 4));
	W32(out, arr != NULL);
	emit_text(out, 4, arr ? cJSON_PrintUnformatted(arr) : NULL);
}
#elif defined(K_CREATE_FLOAT_ARRAY)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	cJSON *arr = cJSON_CreateFloatArray((const float *)P(r->in), (int)(r->len / 4));
	W32(out, arr != NULL);
	emit_text(out, 4, arr ? cJSON_PrintUnformatted(arr) : NULL);
}
#elif defined(K_CREATE_DOUBLE_ARRAY)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	cJSON *arr = cJSON_CreateDoubleArray((const double *)P(r->in), (int)(r->len / 8));
	W32(out, arr != NULL);
	emit_text(out, 4, arr ? cJSON_PrintUnformatted(arr) : NULL);
}
#elif defined(K_CREATE_STRING_ARRAY)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	const char *strs[64];
	int k = 0;
	const char *p = (const char *)P(r->in);
	const char *end = p + r->len;
	while (p < end && k < 64) {
		strs[k++] = p;
		p += strlen(p) + 1;
	}
	cJSON *arr = cJSON_CreateStringArray(strs, k);
	W32(out, arr != NULL);
	emit_text(out, 4, arr ? cJSON_PrintUnformatted(arr) : NULL);
}
#else
#error kernel
#endif

#include "loop.h"
