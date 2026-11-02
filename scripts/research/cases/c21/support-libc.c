#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>

typedef struct corpus_file FILE;
FILE *stderr;

char *strchr(const char *value, int ch) {
	for (;; value++) {
		if (*value == (char)ch) return (char *)value;
		if (!*value) return 0;
	}
}
int strcmp(const char *a, const char *b) {
	while (*a && *a == *b) a++, b++;
	return (unsigned char)*a - (unsigned char)*b;
}
int strncmp(const char *a, const char *b, size_t count) {
	for (size_t i = 0; i < count; i++) {
		if (a[i] != b[i]) return (unsigned char)a[i] - (unsigned char)b[i];
		if (!a[i]) return 0;
	}
	return 0;
}
void exit(int status) {
	(void)status;
	__builtin_trap();
}

void *bsearch(const void *key, const void *base, size_t count, size_t size,
	int (*compare)(const void *, const void *)) {
	size_t low = 0, high = count;
	while (low < high) {
		size_t mid = low + (high - low) / 2;
		const char *item = (const char *)base + mid * size;
		int order = compare(key, item);
		if (!order) return (void *)item;
		if (order < 0) high = mid;
		else low = mid + 1;
	}
	return 0;
}

/* insertion sort; the sorted sets of md4c are small */
void qsort(void *base, size_t count, size_t size, int (*compare)(const void *, const void *)) {
	char *items = (char *)base;
	for (size_t i = 1; i < count; i++) {
		size_t j = i;
		while (j > 0 && compare(items + (j - 1) * size, items + j * size) > 0) {
			for (size_t k = 0; k < size; k++) {
				char tmp = items[(j - 1) * size + k];
				items[(j - 1) * size + k] = items[j * size + k];
				items[j * size + k] = tmp;
			}
			j--;
		}
	}
}

/* conversions %u %d %x %s and %% only, which is all md4c-html asks for */
int snprintf(char *out, size_t cap, const char *format, ...) {
	va_list args;
	va_start(args, format);
	size_t at = 0;
#define PUT(c) \
	do { \
		if (at + 1 < cap) out[at] = (c); \
		at++; \
	} while (0)
	for (; *format; format++) {
		if (*format != '%') {
			PUT(*format);
			continue;
		}
		format++;
		if (*format == 's') {
			for (const char *s = va_arg(args, const char *); *s; s++) PUT(*s);
		} else if (*format == 'u' || *format == 'd' || *format == 'x') {
			unsigned value = va_arg(args, unsigned);
			unsigned base = *format == 'x' ? 16 : 10;
			if (*format == 'd' && (int)value < 0) {
				PUT('-');
				value = -value;
			}
			char digits[16];
			int count = 0;
			do digits[count++] = "0123456789abcdef"[value % base];
			while ((value /= base));
			while (count) PUT(digits[--count]);
		} else {
			PUT(*format);
		}
	}
	if (cap) out[at < cap ? at : cap - 1] = 0;
	va_end(args);
	return (int)at;
}
int fprintf(FILE *file, const char *format, ...) {
	(void)file;
	(void)format;
	return 0;
}
