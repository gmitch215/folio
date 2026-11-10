#include <stdint.h>
#include <string.h>

#include "harness.h"

#define STB_C_LEXER_IMPLEMENTATION
#include "stb_c_lexer.h"
#define STB_DS_IMPLEMENTATION
#include "stb_ds.h"
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

typedef struct {
	uint32_t key;
	uint32_t value;
} kv_t;

typedef struct {
	uint8_t *p;
	uint32_t n;
} wbuf;

static uint32_t next(uint32_t *s) {
	*s = *s * 1664525u + 1013904223u;
	return *s >> 8;
}

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

static void put_u16le(wbuf *w, uint32_t v) {
	w->p[w->n++] = (uint8_t)(v & 255);
	w->p[w->n++] = (uint8_t)((v >> 8) & 255);
}

static uint32_t fnv(const uint8_t *p, size_t n) {
	uint32_t h = 2166136261u;
	for (size_t j = 0; j < n; j++) h = (h ^ p[j]) * 16777619u;
	return h;
}

// key j of record r: a byte of the record and j, so keys are distinct.
static uint32_t key_of(const rec_t *r, uint32_t j) {
	return (uint32_t)((const uint8_t *)P(r->in))[j % r->len] | (j << 8);
}

static void fill_map(kv_t **m, const rec_t *r) {
	uint32_t n = 1 + r->len % 24;
	for (uint32_t j = 0; j < n; j++) {
		uint32_t k = key_of(r, j);
		uint32_t v = j * 3 + 1;
		stbds_hmput(*m, k, v);
	}
}

static uint32_t raw_len(uint32_t i) { return 1 + (i * 37) % 512; }

static uint32_t gen_raw(uint32_t i, uint8_t *dst) {
	uint32_t len = raw_len(i);
	raw_fill(dst, len);
	return len;
}

// tokens with identifiers, integers, punctuation, string literals and comments; no reals.
static const char *words[] = {"alpha", "beta_2", "gamma", "delta", "x", "y9"};
static const char *puncts[] = {"+", "-", "*", "(", ")", ";", ",", "=", "[", "]"};

static uint32_t gen_lex(uint32_t i, uint8_t *dst) {
	wbuf w = {dst, 0};
	uint32_t s = i * 2654435761u + 12345u;
	uint32_t target = 64 + (i * 37) % 400;
	while (w.n < target) {
		switch (next(&s) % 5) {
		case 0:
			put(&w, words[next(&s) % 6]);
			break;
		case 1:
			put_uint(&w, next(&s) % 100000);
			break;
		case 2:
			put(&w, puncts[next(&s) % 10]);
			break;
		case 3:
			put(&w, "\"str");
			put_uint(&w, next(&s) % 1000);
			put(&w, "\"");
			break;
		default:
			put(&w, "/* c */ // line\n");
			break;
		}
		put(&w, " ");
	}
	return w.n;
}

// a NUL-terminated key string, distinct per record.
static uint32_t gen_str(uint32_t i, uint8_t *dst) {
	wbuf w = {dst, 0};
	put(&w, "key");
	put_uint(&w, i);
	put(&w, "_");
	put_uint(&w, (i * 2654435761u) % 100000);
	dst[w.n++] = 0;
	return w.n;
}

// two words: the element count to add and the minimum capacity.
static uint32_t gen_grow(uint32_t i, uint8_t *dst) {
	uint32_t s = i * 2654435761u + 7u;
	uint32_t a = next(&s), b = next(&s);
	memcpy(dst, &a, 4);
	memcpy(dst + 4, &b, 4);
	return 8;
}

static void be32(uint8_t *p, uint32_t v) {
	p[0] = (uint8_t)(v >> 24);
	p[1] = (uint8_t)(v >> 16);
	p[2] = (uint8_t)(v >> 8);
	p[3] = (uint8_t)v;
}

static uint32_t crc32(const uint8_t *p, size_t n) {
	uint32_t crc = 0xFFFFFFFFu;
	for (size_t j = 0; j < n; j++) {
		crc ^= p[j];
		for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
	}
	return ~crc;
}

static void put_chunk(wbuf *o, const char *type, const uint8_t *data, uint32_t n) {
	be32(o->p + o->n, n);
	o->n += 4;
	size_t start = o->n;
	memcpy(o->p + o->n, type, 4);
	o->n += 4;
	if (n) memcpy(o->p + o->n, data, n);
	o->n += n;
	be32(o->p + o->n, crc32(o->p + start, o->n - start));
	o->n += 4;
}

// an RGB PNG with filter 0 and one stored deflate block. stb_image_write needs frexp,
// which the shim does not provide, so the encoder is written out here.
static uint8_t png_raw[32 * (1 + 32 * 3)];
static uint8_t png_idat[32 * (1 + 32 * 3) + 16];
static uint8_t png_hdr[13];

static uint32_t gen_png(uint32_t i, uint8_t *dst) {
	uint32_t w = 8 + (i * 5) % 25, h = 8 + (i * 7) % 25;
	uint32_t n = 0;
	for (uint32_t y = 0; y < h; y++) {
		png_raw[n++] = 0;
		for (uint32_t x = 0; x < w * 3; x++)
			png_raw[n++] = (uint8_t)((y * 96 + x * 13 + (x >> 7) + i * 31) & 255);
	}
	uint32_t m = 0;
	png_idat[m++] = 0x78;
	png_idat[m++] = 0x01;
	png_idat[m++] = 1;
	png_idat[m++] = (uint8_t)(n & 255);
	png_idat[m++] = (uint8_t)(n >> 8);
	png_idat[m++] = (uint8_t)(~n & 255);
	png_idat[m++] = (uint8_t)((~n >> 8) & 255);
	memcpy(png_idat + m, png_raw, n);
	m += n;
	uint32_t a = 1, b = 0;
	for (uint32_t j = 0; j < n; j++) {
		a = (a + png_raw[j]) % 65521;
		b = (b + a) % 65521;
	}
	be32(png_idat + m, (b << 16) | a);
	m += 4;

	be32(png_hdr, w);
	be32(png_hdr + 4, h);
	png_hdr[8] = 8;
	png_hdr[9] = 2;
	png_hdr[10] = png_hdr[11] = png_hdr[12] = 0;

	static const uint8_t sig[8] = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
	wbuf o = {dst, 0};
	memcpy(dst, sig, 8);
	o.n = 8;
	put_chunk(&o, "IHDR", png_hdr, 13);
	put_chunk(&o, "IDAT", png_idat, m);
	put_chunk(&o, "IEND", png_hdr, 0);
	return o.n;
}

// one frame, global palette of 256 greys, literal LZW codes with a clear every 250 pixels.
static uint8_t lz[2048];

static uint32_t gen_gif(uint32_t i, uint8_t *dst) {
	uint32_t w = 8 + (i * 5) % 25, h = 8 + (i * 7) % 25;
	uint32_t n = w * h;
	wbuf o = {dst, 0};
	put(&o, "GIF89a");
	put_u16le(&o, w);
	put_u16le(&o, h);
	o.p[o.n++] = 0xF7;
	o.p[o.n++] = 0;
	o.p[o.n++] = 0;
	for (uint32_t k = 0; k < 256; k++) {
		o.p[o.n++] = (uint8_t)k;
		o.p[o.n++] = (uint8_t)k;
		o.p[o.n++] = (uint8_t)k;
	}
	o.p[o.n++] = 0x2C;
	put_u16le(&o, 0);
	put_u16le(&o, 0);
	put_u16le(&o, w);
	put_u16le(&o, h);
	o.p[o.n++] = 0;
	o.p[o.n++] = 8;

	uint32_t acc = 0, bits = 0, k = 0, count = 0;
	uint32_t codes[1024 + 8];
	uint32_t nc = 0;
	codes[nc++] = 256;
	for (uint32_t j = 0; j < n; j++) {
		if (count == 250) {
			codes[nc++] = 256;
			count = 0;
		}
		codes[nc++] = (j * 13 + (j >> 7) + i * 31) & 255;
		count++;
	}
	codes[nc++] = 257;
	for (uint32_t c = 0; c < nc; c++) {
		acc |= codes[c] << bits;
		bits += 9;
		while (bits >= 8) {
			lz[k++] = (uint8_t)(acc & 255);
			acc >>= 8;
			bits -= 8;
		}
	}
	if (bits > 0) lz[k++] = (uint8_t)(acc & 255);
	for (uint32_t off = 0; off < k;) {
		uint32_t len = k - off < 255 ? k - off : 255;
		o.p[o.n++] = (uint8_t)len;
		memcpy(o.p + o.n, lz + off, len);
		o.n += len;
		off += len;
	}
	o.p[o.n++] = 0;
	o.p[o.n++] = 0x3B;
	return o.n;
}

#if defined(K_LEXER_INIT)
#define GEN(i, dst) gen_lex(i, dst)
#elif defined(K_HASH_BYTES)
#define GEN(i, dst) gen_raw(i, dst)
#elif defined(K_HASH_STRING)
#define GEN(i, dst) gen_str(i, dst)
#elif defined(K_ARRGROWF)
#define GEN(i, dst) gen_grow(i, dst)
#elif defined(K_HMFREE_FUNC) || defined(K_HMGET_KEY) || defined(K_HMGET_KEY_TS)
#define GEN(i, dst) gen_raw(i, dst)
#elif defined(K_HMPUT_DEFAULT) || defined(K_HMPUT_KEY) || defined(K_HMDEL_KEY)
#define GEN(i, dst) gen_raw(i, dst)
#elif defined(K_STBI_LOAD)
#define GEN(i, dst) gen_png(i, dst)
#elif defined(K_STBI_LOAD_GIF)
#define GEN(i, dst) gen_gif(i, dst)
#else
#error kernel
#endif

#if defined(K_LEXER_INIT)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	stb_lexer lex;
	memset(&lex, 0, sizeof lex);
	char store[256];
	const char *in = (const char *)P(r->in);
	stb_c_lexer_init(&lex, in, in + r->len, store, sizeof store);
	uint32_t n = 0, h = 2166136261u;
	while (n < 4096 && stb_c_lexer_get_token(&lex)) {
		n++;
		h = (h ^ (uint32_t)lex.token) * 16777619u;
		h = (h ^ (uint32_t)lex.int_number) * 16777619u;
		h = (h ^ (uint32_t)lex.string_len) * 16777619u;
	}
	W32(out, n);
	W32(out + 4, h);
	W32(out + 8, (uint32_t)lex.token);
}
#elif defined(K_HASH_BYTES)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t h = stbds_hash_bytes(P(r->in), r->len, 0x9e3779b9u);
	W32(out, (uint32_t)h);
}
#elif defined(K_HASH_STRING)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t h = stbds_hash_string((char *)P(r->in), 0x9e3779b9u);
	W32(out, (uint32_t)h);
}
#elif defined(K_ARRGROWF)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	uint32_t addlen, min_cap;
	memcpy(&addlen, P(r->in), 4);
	memcpy(&min_cap, (const uint8_t *)P(r->in) + 4, 4);
	void *a = stbds_arrgrowf(NULL, 4, addlen % 512, min_cap % 1024);
	W32(out, (uint32_t)stbds_arrcap(a));
	W32(out + 4, (uint32_t)stbds_arrlen(a));
}
#elif defined(K_HMFREE_FUNC)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	kv_t *m = NULL;
	fill_map(&m, r);
	W32(out, (uint32_t)stbds_hmlen(m));
	stbds_hmfree_func((kv_t *)m - 1, sizeof *m);
}
#elif defined(K_HMGET_KEY)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	kv_t *m = NULL;
	fill_map(&m, r);
	uint32_t k = key_of(r, 0);
	void *p = stbds_hmget_key(m, sizeof *m, &k, sizeof k, STBDS_HM_BINARY);
	ptrdiff_t idx = stbds_temp((kv_t *)p - 1);
	W32(out, (uint32_t)idx);
	W32(out + 4, ((kv_t *)p)[idx].value);
}
#elif defined(K_HMGET_KEY_TS)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	kv_t *m = NULL;
	fill_map(&m, r);
	uint32_t k = key_of(r, 0);
	ptrdiff_t temp = 0;
	void *p = stbds_hmget_key_ts(m, sizeof *m, &k, sizeof k, &temp, STBDS_HM_BINARY);
	W32(out, (uint32_t)temp);
	W32(out + 4, ((kv_t *)p)[temp].value);
}
#elif defined(K_HMPUT_DEFAULT)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	kv_t *a = stbds_hmput_default(NULL, sizeof *a);
	W32(out, (uint32_t)stbds_hmlen(a));
	fill_map(&a, r);
	kv_t *b = stbds_hmput_default(a, sizeof *b);
	W32(out + 4, (uint32_t)stbds_hmlen(b));
}
#elif defined(K_HMPUT_KEY)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	kv_t *a = stbds_hmput_default(NULL, sizeof *a);
	uint32_t n = 1 + r->len % 24;
	for (uint32_t j = 0; j < n; j++) {
		uint32_t k = key_of(r, j);
		a = stbds_hmput_key(a, sizeof *a, &k, sizeof k, STBDS_HM_BINARY);
		a[stbds_temp(a - 1)].value = j * 3 + 1;
	}
	W32(out, (uint32_t)stbds_hmlen(a));
	W32(out + 4, (uint32_t)stbds_temp(a - 1));
}
#elif defined(K_HMDEL_KEY)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	kv_t *m = NULL;
	fill_map(&m, r);
	uint32_t k = key_of(r, 0);
	kv_t *p = stbds_hmdel_key(m, sizeof *m, &k, sizeof k, 0, STBDS_HM_BINARY);
	W32(out, (uint32_t)stbds_hmlen(p));
	W32(out + 4, p ? (uint32_t)stbds_temp(p - 1) : 0);
}
#elif defined(K_STBI_LOAD)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	int x = 0, y = 0, comp = 0;
	stbi_uc *px = stbi_load_from_memory(P(r->in), (int)r->len, &x, &y, &comp, 0);
	W32(out, px != NULL);
	W32(out + 4, (uint32_t)x);
	W32(out + 8, (uint32_t)y);
	W32(out + 12, (uint32_t)comp);
	W32(out + 16, px ? fnv(px, (size_t)x * y * comp) : 0);
}
#elif defined(K_STBI_LOAD_GIF)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	int *delays = NULL;
	int x = 0, y = 0, z = 0, comp = 0;
	stbi_uc *px = stbi_load_gif_from_memory(P(r->in), (int)r->len, &delays, &x, &y, &z, &comp, 0);
	W32(out, px != NULL);
	W32(out + 4, (uint32_t)x);
	W32(out + 8, (uint32_t)y);
	W32(out + 12, (uint32_t)z);
	W32(out + 16, (uint32_t)comp);
	W32(out + 20, px ? fnv(px, (size_t)x * y * comp * z) : 0);
	W32(out + 24, delays ? fnv((const uint8_t *)delays, (size_t)z * sizeof *delays) : 0);
}
#endif

#include "loop.h"
