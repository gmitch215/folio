#include <stdint.h>
#include <string.h>

#include "harness.h"

#define W64(p, v) (*(uint64_t *)(p) = (uint64_t)(v))

#define DR_WAV_IMPLEMENTATION
#include "dr_wav.h"

typedef struct {
	uint8_t *buf;
	size_t cap;
	size_t pos;
} sink_t;

static size_t sink_write(void *user, const void *data, size_t size) {
	sink_t *s = user;
	size_t room = s->cap - s->pos;
	size_t n = size < room ? size : room;
	memcpy(s->buf + s->pos, data, n);
	s->pos += n;
	return n;
}

static drwav_bool32 sink_seek(void *user, int offset, drwav_seek_origin origin) {
	sink_t *s = user;
	size_t base = origin == DRWAV_SEEK_SET ? 0 : s->pos;
	if ((long long)base + offset < 0 || (long long)base + offset > (long long)s->cap) return DRWAV_FALSE;
	s->pos = base + (size_t)offset;
	return DRWAV_TRUE;
}

static drwav_data_format format(void) {
	drwav_data_format f;
	memset(&f, 0, sizeof f);
	f.container = drwav_container_riff;
	f.format = DR_WAVE_FORMAT_PCM;
	f.channels = 2;
	f.sampleRate = 48000;
	f.bitsPerSample = 16;
	return f;
}

static uint32_t raw_len(uint32_t i) { return 64 + (i * 37) % 704; }

static uint32_t gen_raw(uint32_t i, uint8_t *dst) {
	uint32_t len = raw_len(i);
	raw_fill(dst, len);
	return len;
}

// floats in [-1, 1), built from the dev byte pattern so no NaN or infinity reaches the converters.
static uint32_t gen_f32(uint32_t i, uint8_t *dst) {
	uint32_t n = 64 + (i * 37) % 176;
	float *f = (float *)dst;
	for (uint32_t j = 0; j < n; j++) f[j] = (float)(((j * 13 + (j >> 7)) & 255) - 128) / 128.0f;
	return n * 4;
}

static uint32_t gen_f64(uint32_t i, uint8_t *dst) {
	uint32_t n = 16 + (i * 37) % 112;
	double *d = (double *)dst;
	for (uint32_t j = 0; j < n; j++) d[j] = (double)(((j * 13 + (j >> 7)) & 255) - 128) / 128.0;
	return n * 8;
}

static void put_u16(uint8_t *p, uint32_t v) {
	p[0] = (uint8_t)v;
	p[1] = (uint8_t)(v >> 8);
}

static void put_u32(uint8_t *p, uint32_t v) {
	put_u16(p, v);
	put_u16(p + 2, v >> 16);
}

// 44-byte PCM WAV header (2 channels, 16 bit, 48 kHz) followed by the raw bytes of the record.
static uint32_t gen_wav(uint32_t i, uint8_t *dst) {
	uint32_t n = raw_len(i);
	memcpy(dst, "RIFF", 4);
	put_u32(dst + 4, 36 + n);
	memcpy(dst + 8, "WAVEfmt ", 8);
	put_u32(dst + 16, 16);
	put_u16(dst + 20, 1);
	put_u16(dst + 22, 2);
	put_u32(dst + 24, 48000);
	put_u32(dst + 28, 48000 * 4);
	put_u16(dst + 32, 4);
	put_u16(dst + 34, 16);
	memcpy(dst + 36, "data", 4);
	put_u32(dst + 40, n);
	raw_fill(dst + 44, n);
	return 44 + n;
}

#if defined(K_INIT_WRITE_SEQUENTIAL)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	drwav wav;
	drwav_data_format f = format();
	sink_t sink = {DATA(out), SLOT - 32, 0};
	drwav_bool32 ok = drwav_init_write_sequential(&wav, &f, r->len, sink_write, &sink, NULL);
	W32(out, ok);
	W32(out + 4, sink.pos);
	if (ok) drwav_uninit(&wav);
}
#elif defined(K_INIT_WRITE_SEQUENTIAL_PCM_FRAMES)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	drwav wav;
	drwav_data_format f = format();
	sink_t sink = {DATA(out), SLOT - 32, 0};
	drwav_bool32 ok = drwav_init_write_sequential_pcm_frames(&wav, &f, r->len, sink_write, &sink, NULL);
	W32(out, ok);
	W32(out + 4, sink.pos);
	if (ok) drwav_uninit(&wav);
}
#elif defined(K_INIT_WRITE_WITH_METADATA)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	(void)r;
	bump_set(P(r->arena), ARENA);
	drwav wav;
	drwav_data_format f = format();
	sink_t sink = {DATA(out), SLOT - 32, 0};
	drwav_bool32 ok = drwav_init_write_with_metadata(&wav, &f, sink_write, sink_seek, &sink, NULL,
		NULL, 0);
	W32(out, ok);
	W32(out + 4, sink.pos);
	if (ok) drwav_uninit(&wav);
}
#elif defined(K_TARGET_WRITE_SIZE_BYTES)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	drwav_data_format f = format();
	W64(out, drwav_target_write_size_bytes(&f, r->len, NULL, 0));
}
#elif defined(K_READ_RAW)
#define GEN(i, dst) gen_wav(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	drwav wav;
	size_t want = r->len < SLOT - 32 ? r->len : SLOT - 32;
	if (!drwav_init_memory(&wav, P(r->in), r->len, NULL)) {
		W64(out, 0);
		return;
	}
	W64(out, drwav_read_raw(&wav, want, DATA(out)));
	drwav_uninit(&wav);
}
#elif defined(K_WRITE_RAW)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	bump_set(P(r->arena), ARENA);
	drwav wav;
	drwav_data_format f = format();
	sink_t sink = {DATA(out), SLOT - 32, 0};
	if (!drwav_init_write_sequential(&wav, &f, r->len, sink_write, &sink, NULL)) {
		W64(out, 0);
		return;
	}
	W64(out, drwav_write_raw(&wav, r->len, P(r->in)));
	drwav_uninit(&wav);
}
#elif defined(K_U8_TO_S16)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	drwav_u8_to_s16((drwav_int16 *)DATA(out), (const drwav_uint8 *)P(r->in), r->len);
	W32(out, r->len);
}
#elif defined(K_S24_TO_S16)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t n = r->len / 3;
	drwav_s24_to_s16((drwav_int16 *)DATA(out), (const drwav_uint8 *)P(r->in), n);
	W32(out, n);
}
#elif defined(K_S32_TO_S16)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t n = r->len / 4;
	drwav_s32_to_s16((drwav_int16 *)DATA(out), (const drwav_int32 *)P(r->in), n);
	W32(out, n);
}
#elif defined(K_F32_TO_S16)
#define GEN(i, dst) gen_f32(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t n = r->len / 4;
	drwav_f32_to_s16((drwav_int16 *)DATA(out), (const float *)P(r->in), n);
	W32(out, n);
}
#elif defined(K_F64_TO_S16)
#define GEN(i, dst) gen_f64(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	size_t n = r->len / 8;
	drwav_f64_to_s16((drwav_int16 *)DATA(out), (const double *)P(r->in), n);
	W32(out, n);
}
#elif defined(K_ALAW_TO_S16)
#define GEN(i, dst) gen_raw(i, dst)
NOINLINE static void one(const rec_t *r, uint8_t *out) {
	drwav_alaw_to_s16((drwav_int16 *)DATA(out), (const drwav_uint8 *)P(r->in), r->len);
	W32(out, r->len);
}
#else
#error kernel
#endif

#include "loop.h"
