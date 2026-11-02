#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

/* bump heap; blocks up to 1 MiB come from power-of-two free lists, larger blocks are exact and never reused */

extern unsigned char __heap_base;

#define CLASS_MIN 5
#define CLASS_MAX 20
#define LARGE 0xFF
#define HEADER 16

typedef struct block {
	size_t size;
	unsigned char cls;
	unsigned char pad[HEADER - sizeof(size_t) - 1];
} block;

static uintptr_t heap_top;
static block *free_by_class[CLASS_MAX + 1];

static void *take(size_t bytes) {
	uintptr_t at = (heap_top + 15) & ~(uintptr_t)15;
	uintptr_t end = at + bytes;
	size_t have = (size_t)__builtin_wasm_memory_size(0) * 65536;
	if (end > have) {
		size_t pages = (end - have + 65535) / 65536;
		if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return 0;
	}
	heap_top = end;
	return (void *)at;
}

void *malloc(size_t n) {
	if (!heap_top) heap_top = (uintptr_t)&__heap_base;
	if (n == 0) n = 1;
	size_t total = n + HEADER;
	if (total > ((size_t)1 << CLASS_MAX)) {
		block *b = take((total + 15) & ~(size_t)15);
		if (!b) return 0;
		b->size = n;
		b->cls = LARGE;
		return (void *)(b + 1);
	}
	size_t c = CLASS_MIN;
	while (((size_t)1 << c) < total) c++;
	block *b = free_by_class[c];
	if (b) {
		free_by_class[c] = *(block **)(b + 1);
		b->size = n;
		return (void *)(b + 1);
	}
	b = take((size_t)1 << c);
	if (!b) return 0;
	b->size = n;
	b->cls = (unsigned char)c;
	return (void *)(b + 1);
}

void free(void *p) {
	if (!p) return;
	block *b = (block *)p - 1;
	if (b->cls == LARGE) return;
	*(block **)(b + 1) = free_by_class[b->cls];
	free_by_class[b->cls] = b;
}

void *calloc(size_t count, size_t size) {
	size_t n = count * size;
	void *p = malloc(n);
	if (p) memset(p, 0, n);
	return p;
}

void *realloc(void *p, size_t n) {
	if (!p) return malloc(n);
	size_t old = ((block *)p - 1)->size;
	if (n <= old) return p;
	void *q = malloc(n);
	if (!q) return 0;
	memcpy(q, p, old);
	free(p);
	return q;
}

size_t malloc_usable_size(void *p) {
	if (!p) return 0;
	return ((block *)p - 1)->size;
}

void abort(void) {
	__builtin_trap();
}

void *memcpy(void *dst, const void *src, size_t n) {
	unsigned char *d = dst;
	const unsigned char *s = src;
	while (n--) *d++ = *s++;
	return dst;
}

void *memmove(void *dst, const void *src, size_t n) {
	unsigned char *d = dst;
	const unsigned char *s = src;
	if (d <= s) {
		while (n--) *d++ = *s++;
	} else {
		d += n;
		s += n;
		while (n--) *--d = *--s;
	}
	return dst;
}

void *memset(void *dst, int c, size_t n) {
	unsigned char *d = dst;
	while (n--) *d++ = (unsigned char)c;
	return dst;
}

int memcmp(const void *a, const void *b, size_t n) {
	const unsigned char *x = a, *y = b;
	for (; n; n--, x++, y++) {
		if (*x != *y) return *x < *y ? -1 : 1;
	}
	return 0;
}

size_t strlen(const char *s) {
	size_t n = 0;
	while (s[n]) n++;
	return n;
}

int strcmp(const char *a, const char *b) {
	while (*a && *a == *b) a++, b++;
	return (unsigned char)*a - (unsigned char)*b;
}

int strncmp(const char *a, const char *b, size_t n) {
	for (; n; n--, a++, b++) {
		if (*a != *b || !*a) return (unsigned char)*a - (unsigned char)*b;
	}
	return 0;
}

char *strchr(const char *s, int c) {
	for (;; s++) {
		if (*s == (char)c) return (char *)s;
		if (!*s) return 0;
	}
}

char *strrchr(const char *s, int c) {
	char *last = 0;
	for (;; s++) {
		if (*s == (char)c) last = (char *)s;
		if (!*s) return last;
	}
}

size_t strspn(const char *s, const char *set) {
	size_t n = 0;
	for (; s[n] && strchr(set, s[n]); n++);
	return n;
}

size_t strcspn(const char *s, const char *set) {
	size_t n = 0;
	for (; s[n] && !strchr(set, s[n]); n++);
	return n;
}

void *memchr(const void *p, int c, size_t n) {
	const unsigned char *s = p;
	for (; n; n--, s++) {
		if (*s == (unsigned char)c) return (void *)s;
	}
	return 0;
}

int abs(int x) {
	return x < 0 ? -x : x;
}

double fabs(double x) {
	return x < 0 ? -x : x;
}

/* date and time functions are compiled in by the amalgamation but never reached from this driver */
struct tm *gmtime(const time_t *t) {
	(void)t;
	return 0;
}

size_t strftime(char *s, size_t n, const char *f, const struct tm *t) {
	(void)s; (void)n; (void)f; (void)t;
	return 0;
}
