#include <stdint.h>
#include <string.h>

#include "harness.h"
#include "picohttpparser.h"

#define MAX_HEADERS 16

static uint32_t put_str(uint8_t *dst, uint32_t at, const char *s) {
	uint32_t n = (uint32_t)strlen(s);
	memcpy(dst + at, s, n);
	return at + n;
}

static uint32_t put_num(uint8_t *dst, uint32_t at, uint32_t v) {
	char digits[12];
	uint32_t n = 0;
	do {
		digits[n++] = (char)('0' + v % 10);
		v /= 10;
	} while (v);
	while (n) dst[at++] = (uint8_t)digits[--n];
	return at;
}

// 1 to 16 header lines per record; the count and the values change with the record index.
static uint32_t put_headers(uint8_t *dst, uint32_t at, uint32_t i) {
	uint32_t count = 1 + i % MAX_HEADERS;
	for (uint32_t k = 0; k < count; k++) {
		at = put_str(dst, at, "X-H");
		at = put_num(dst, at, k);
		at = put_str(dst, at, ": v");
		at = put_num(dst, at, i * 7 + k);
		at = put_str(dst, at, "\r\n");
	}
	return at;
}

static uint32_t gen_request(uint32_t i, uint8_t *dst) {
	uint32_t at = put_str(dst, 0, "GET /r");
	at = put_num(dst, at, i);
	at = put_str(dst, at, " HTTP/1.1\r\nHost: example.test\r\n");
	at = put_headers(dst, at, i);
	return put_str(dst, at, "\r\n");
}

static uint32_t gen_response(uint32_t i, uint8_t *dst) {
	uint32_t at = put_str(dst, 0, "HTTP/1.1 ");
	at = put_num(dst, at, 200 + i % 4);
	at = put_str(dst, at, " Reason\r\n");
	at = put_headers(dst, at, i);
	return put_str(dst, at, "\r\n");
}

static uint32_t gen_headers(uint32_t i, uint8_t *dst) {
	uint32_t at = put_headers(dst, 0, i);
	return put_str(dst, at, "\r\n");
}

static uint32_t offset_of(const void *p, addr_t base) {
	return (uint32_t)((uintptr_t)p - (uintptr_t)base);
}

// writes header k as four words at DATA(out) + 16 * k; offsets are into the record input.
static void store_headers(uint8_t *out, const struct phr_header *headers, size_t n, addr_t base) {
	for (size_t k = 0; k < n && k < MAX_HEADERS; k++) {
		uint8_t *slot = DATA(out) + 16 * k;
		W32(slot, offset_of(headers[k].name, base));
		W32(slot + 4, headers[k].name_len);
		W32(slot + 8, offset_of(headers[k].value, base));
		W32(slot + 12, headers[k].value_len);
	}
}

#if defined(K_PARSE_REQUEST)
#define GEN(i, dst) gen_request(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	const char *method = NULL, *path = NULL;
	size_t method_len = 0, path_len = 0, num_headers = MAX_HEADERS;
	int minor_version = -1;
	struct phr_header headers[MAX_HEADERS];
	int ret = phr_parse_request((const char *)P(r->in), r->len, &method, &method_len, &path,
		&path_len, &minor_version, headers, &num_headers, 0);
	W32(out, ret);
	W32(out + 4, offset_of(method, r->in));
	W32(out + 8, method_len);
	W32(out + 12, offset_of(path, r->in));
	W32(out + 16, path_len);
	W32(out + 20, minor_version);
	W32(out + 24, num_headers);
	store_headers(out, headers, num_headers, r->in);
}
#elif defined(K_PARSE_RESPONSE)
#define GEN(i, dst) gen_response(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	const char *msg = NULL;
	size_t msg_len = 0, num_headers = MAX_HEADERS;
	int minor_version = -1, status = 0;
	struct phr_header headers[MAX_HEADERS];
	int ret = phr_parse_response((const char *)P(r->in), r->len, &minor_version, &status, &msg,
		&msg_len, headers, &num_headers, 0);
	W32(out, ret);
	W32(out + 4, minor_version);
	W32(out + 8, status);
	W32(out + 12, offset_of(msg, r->in));
	W32(out + 16, msg_len);
	W32(out + 20, num_headers);
	store_headers(out, headers, num_headers, r->in);
}
#elif defined(K_PARSE_HEADERS)
#define GEN(i, dst) gen_headers(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t num_headers = MAX_HEADERS;
	struct phr_header headers[MAX_HEADERS];
	int ret = phr_parse_headers((const char *)P(r->in), r->len, headers, &num_headers, 0);
	W32(out, ret);
	W32(out + 4, num_headers);
	store_headers(out, headers, num_headers, r->in);
}
#else
#error kernel
#endif

#include "loop.h"
