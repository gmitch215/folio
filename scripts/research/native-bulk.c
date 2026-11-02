#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* native baseline for the bulk drivers: the same one(rec, out) loop on one thread and on T threads */

typedef struct {
	uintptr_t in;
	uint32_t len;
	uintptr_t aux, arena;
} rec_t;

uint32_t bulk(const rec_t *table, uint32_t n, uint8_t *out);
#ifdef NB_CONFIG
void setup(void *mem, uint32_t count, uint32_t nfft);
#endif

/* the library sources are built with malloc and friends renamed to these; the allocator state is
   thread-local, so every thread bumps inside the arena of its own slice */
static __thread unsigned char *region;
static __thread size_t limit;
static __thread size_t cursor;

void bump_set(void *base, size_t size) {
	region = (unsigned char *)base;
	limit = size;
	cursor = 0;
}
void *nb_malloc(size_t size) {
	size_t start = (cursor + 31) & ~(size_t)15;
	if (start > limit || size > limit - start) return 0;
	((size_t *)(region + start))[-1] = size;
	cursor = start + size;
	return region + start;
}
void nb_free(void *ptr) { (void)ptr; }
void *nb_calloc(size_t count, size_t size) {
	if (size && count > (size_t)-1 / size) return 0;
	void *ptr = nb_malloc(count * size);
	if (ptr) memset(ptr, 0, count * size);
	return ptr;
}
void *nb_realloc(void *ptr, size_t size) {
	void *next = nb_malloc(size);
	if (ptr && next) {
		size_t old = ((size_t *)ptr)[-1];
		memcpy(next, ptr, old < size ? old : size);
	}
	return next;
}

static double now_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static void *aligned(size_t size) {
	void *p = 0;
	if (posix_memalign(&p, 4096, size ? size : 1)) {
		fprintf(stderr, "out of memory\n");
		exit(1);
	}
	memset(p, 0, size);
	return p;
}

#define MAX_SLICES 64

typedef struct {
	uint32_t from, to;
} slice_t;

static slice_t slices[MAX_SLICES];
static uint32_t nslices;
static const rec_t *job_table;
static uint8_t *job_out;
static uint32_t slot;

/* contiguous slices of ceil(n / T) records, the split the slice pool makes */
static void split(uint32_t n, uint32_t threads) {
	uint32_t grain = (n + threads - 1) / threads;
	if (!grain) grain = 1;
	nslices = 0;
	for (uint32_t from = 0; from < n; from += grain) {
		slices[nslices].from = from;
		slices[nslices].to = from + grain < n ? from + grain : n;
		nslices++;
	}
}

static void run_slice(uint32_t k) {
	bulk(job_table + slices[k].from, slices[k].to - slices[k].from,
		job_out + (size_t)slices[k].from * slot);
}

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t wake = PTHREAD_COND_INITIALIZER;
static pthread_cond_t idle = PTHREAD_COND_INITIALIZER;
static uint64_t generation;
static uint32_t finished;
static int quit;

static void *worker(void *arg) {
	uint32_t k = (uint32_t)(uintptr_t)arg;
	uint64_t seen = 0;
	for (;;) {
		pthread_mutex_lock(&lock);
		while (generation == seen && !quit) pthread_cond_wait(&wake, &lock);
		if (quit) {
			pthread_mutex_unlock(&lock);
			return 0;
		}
		seen = generation;
		pthread_mutex_unlock(&lock);
		run_slice(k);
		pthread_mutex_lock(&lock);
		finished++;
		pthread_cond_signal(&idle);
		pthread_mutex_unlock(&lock);
	}
}

static void run_parallel(void) {
	pthread_mutex_lock(&lock);
	finished = 0;
	generation++;
	pthread_cond_broadcast(&wake);
	pthread_mutex_unlock(&lock);
	run_slice(0);
	pthread_mutex_lock(&lock);
	while (finished < nslices - 1) pthread_cond_wait(&idle, &lock);
	pthread_mutex_unlock(&lock);
}

static int by_value(const void *a, const void *b) {
	double x = *(const double *)a, y = *(const double *)b;
	return x < y ? -1 : x > y;
}
static double median(const double *values, int count) {
	double copy[256];
	memcpy(copy, values, count * sizeof(double));
	qsort(copy, count, sizeof(double), by_value);
	return count % 2 ? copy[count / 2] : (copy[count / 2 - 1] + copy[count / 2]) / 2;
}

static uint32_t word(const uint8_t **at) {
	uint32_t v;
	memcpy(&v, *at, 4);
	*at += 4;
	return v;
}

/* the slot and byte of the first difference, or -1 */
static long first_diff(const uint8_t *a, const uint8_t *b, uint32_t n, long *byte) {
	for (uint32_t i = 0; i < n; i++) {
		const uint8_t *x = a + (size_t)i * slot, *y = b + (size_t)i * slot;
		if (memcmp(x, y, slot)) {
			for (uint32_t k = 0; k < slot; k++)
				if (x[k] != y[k]) {
					*byte = k;
					break;
				}
			return i;
		}
	}
	return -1;
}

int main(int argc, char **argv) {
	if (argc < 4) {
		fprintf(stderr, "usage: %s DRIVER DATAFILE THREADS [ROUNDS] [WARMUPS]\n", argv[0]);
		return 2;
	}
	const char *driver = argv[1];
	uint32_t threads = (uint32_t)atoi(argv[3]);
	int rounds = argc > 4 ? atoi(argv[4]) : 5;
	int warmups = argc > 5 ? atoi(argv[5]) : 2;
	if (threads < 1 || rounds < 1 || rounds > 256 || warmups < 0) return 2;

	FILE *file = fopen(argv[2], "rb");
	if (!file) {
		perror(argv[2]);
		return 1;
	}
	fseek(file, 0, SEEK_END);
	long size = ftell(file);
	fseek(file, 0, SEEK_SET);
	uint8_t *raw = malloc(size);
	if (fread(raw, 1, size, file) != (size_t)size) return 1;
	fclose(file);

	const uint8_t *at = raw;
	if (word(&at) != 0x314b424e) {
		fprintf(stderr, "bad magic\n");
		return 1;
	}
	uint32_t n = word(&at);
	slot = word(&at);
	uint32_t aux_bytes = word(&at);
	uint32_t arena_bytes = word(&at);
	uint32_t nfft = word(&at);
	uint32_t stride = word(&at);
	uint32_t per_record = word(&at);

	rec_t *serial_table = calloc(n, sizeof(rec_t));
	rec_t *parallel_table = calloc(n, sizeof(rec_t));
	uint8_t *aux0 = aligned((size_t)n * aux_bytes);
	uint8_t *aux = aligned((size_t)n * aux_bytes);
	uint64_t total = 0;
	const uint8_t *scan = at;
	for (uint32_t i = 0; i < n; i++) {
		uint32_t len = word(&scan);
		scan += len + aux_bytes;
		total += ((uint64_t)len + 32 + 31) / 32 * 32;
	}
	uint8_t *data = aligned(total);
	size_t cursor_in = 0;
	for (uint32_t i = 0; i < n; i++) {
		uint32_t len = word(&at);
		memcpy(data + cursor_in, at, len);
		at += len;
		memcpy(aux0 + (size_t)i * aux_bytes, at, aux_bytes);
		at += aux_bytes;
		serial_table[i].in = (uintptr_t)(data + cursor_in);
		serial_table[i].len = len;
		cursor_in += ((size_t)len + 32 + 31) / 32 * 32;
	}

	uint8_t *config = 0;
#ifdef NB_CONFIG
	uint32_t copies = per_record ? n : 1;
	config = aligned((size_t)copies * stride);
	setup(config, copies, nfft);
#else
	(void)nfft;
	(void)stride;
	(void)per_record;
#endif
	for (uint32_t i = 0; i < n; i++) {
		if (config) serial_table[i].aux = (uintptr_t)(config + (per_record ? (size_t)i * stride : 0));
		else if (aux_bytes) serial_table[i].aux = (uintptr_t)(aux + (size_t)i * aux_bytes);
	}

	split(n, threads);
	size_t arena_size = (size_t)(arena_bytes < 64 ? 64 : arena_bytes);
	arena_size = (arena_size + 4095) / 4096 * 4096;
	uint8_t *arenas = aligned(arena_size * (nslices ? nslices : 1));
	for (uint32_t i = 0; i < n; i++) {
		parallel_table[i] = serial_table[i];
		parallel_table[i].arena = 0;
		serial_table[i].arena = (uintptr_t)arenas;
	}
	for (uint32_t k = 0; k < nslices; k++)
		for (uint32_t i = slices[k].from; i < slices[k].to; i++)
			parallel_table[i].arena = (uintptr_t)(arenas + k * arena_size);

	uint8_t *serial_out = aligned((size_t)n * slot);
	uint8_t *parallel_out = aligned((size_t)n * slot);

	pthread_attr_t attr;
	pthread_attr_init(&attr);
	pthread_attr_setstacksize(&attr, 8 << 20);
	pthread_t pool[MAX_SLICES];
	for (uint32_t k = 1; k < nslices; k++) {
		if (pthread_create(&pool[k], &attr, worker, (void *)(uintptr_t)k)) {
			fprintf(stderr, "pthread_create failed\n");
			return 1;
		}
	}

	double serial_ms[256], parallel_ms[256];
	int equal = 1;
	long bad_slot = -1, bad_byte = 0;
	for (int round = -warmups; round < rounds; round++) {
		for (int arm = 0; arm < 2; arm++) {
			memcpy(aux, aux0, (size_t)n * aux_bytes);
			uint8_t *out = arm ? parallel_out : serial_out;
			memset(out, 0, (size_t)n * slot);
			job_table = arm ? parallel_table : serial_table;
			job_out = out;
			double t0 = now_ms();
			if (arm) run_parallel();
			else bulk(serial_table, n, serial_out);
			double t1 = now_ms();
			if (round >= 0) (arm ? parallel_ms : serial_ms)[round] = t1 - t0;
		}
		long byte = 0;
		long diff = first_diff(serial_out, parallel_out, n, &byte);
		if (diff >= 0 && equal) {
			equal = 0;
			bad_slot = diff;
			bad_byte = byte;
		}
	}

	pthread_mutex_lock(&lock);
	quit = 1;
	pthread_cond_broadcast(&wake);
	pthread_mutex_unlock(&lock);
	for (uint32_t k = 1; k < nslices; k++) pthread_join(pool[k], 0);

	double s = median(serial_ms, rounds), p = median(parallel_ms, rounds);
	printf("{\"driver\":\"%s\",\"n\":%u,\"threads\":%u,\"slices\":%u,\"rounds\":%d,", driver, n,
		threads, nslices, rounds);
	printf("\"serialMs\":%.4f,\"parallelMs\":%.4f,\"speedup\":%.4f,\"equal\":%s", s, p, s / p,
		equal ? "true" : "false");
	if (!equal) printf(",\"firstDiffSlot\":%ld,\"firstDiffByte\":%ld", bad_slot, bad_byte);
	printf(",\"serialSamples\":[");
	for (int i = 0; i < rounds; i++) printf("%s%.4f", i ? "," : "", serial_ms[i]);
	printf("],\"parallelSamples\":[");
	for (int i = 0; i < rounds; i++) printf("%s%.4f", i ? "," : "", parallel_ms[i]);
	printf("]}\n");
	return equal ? 0 : 3;
}
