#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <pthread.h>
#include <sys/stat.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
#include <wchar.h>

int errno;
FILE *stdin;
FILE *stdout;
FILE *stderr;

#define HEADER 16u

static unsigned char *region;
static size_t limit;
static size_t cursor;

// base must be 16-byte aligned; nothing is zeroed
void bump_set(void *base, size_t size) {
	region = base;
	limit = size;
	cursor = 0;
}

void *malloc(size_t size) {
	if (size > limit || limit - cursor < HEADER) return 0;
	size_t block = (size + 15) & ~(size_t)15;
	if (block > limit - cursor - HEADER) return 0;
	unsigned char *head = region + cursor;
	*(size_t *)head = size;
	cursor += HEADER + block;
	return head + HEADER;
}

void free(void *ptr) {
	(void)ptr;
}

void *calloc(size_t count, size_t size) {
	if (size && count > SIZE_MAX / size) return 0;
	size_t total = count * size;
	void *ptr = malloc(total);
	if (ptr) memset(ptr, 0, total);
	return ptr;
}

void *realloc(void *ptr, size_t size) {
	void *next = malloc(size);
	if (ptr && next) {
		size_t old = *(size_t *)((unsigned char *)ptr - HEADER);
		memcpy(next, ptr, old < size ? old : size);
	}
	return next;
}

void abort(void) {
	__builtin_trap();
}

void exit(int status) {
	(void)status;
	__builtin_trap();
}

char *getenv(const char *name) {
	(void)name;
	errno = ENOSYS;
	return 0;
}

int abs(int value) {
	return value < 0 ? -value : value;
}

long labs(long value) {
	return value < 0 ? -value : value;
}

void *memcpy(void *dst, const void *src, size_t count) {
	unsigned char *d = dst;
	const unsigned char *s = src;
	while (count--) *d++ = *s++;
	return dst;
}

void *memmove(void *dst, const void *src, size_t count) {
	unsigned char *d = dst;
	const unsigned char *s = src;
	if (d <= s) {
		while (count--) *d++ = *s++;
	} else {
		d += count;
		s += count;
		while (count--) *--d = *--s;
	}
	return dst;
}

void *memset(void *dst, int value, size_t count) {
	unsigned char *d = dst;
	while (count--) *d++ = (unsigned char)value;
	return dst;
}

int memcmp(const void *a, const void *b, size_t count) {
	const unsigned char *p = a, *q = b;
	for (; count; count--, p++, q++)
		if (*p != *q) return *p - *q;
	return 0;
}

void *memchr(const void *src, int value, size_t count) {
	const unsigned char *p = src;
	for (; count; count--, p++)
		if (*p == (unsigned char)value) return (void *)p;
	return 0;
}

size_t strlen(const char *s) {
	const char *p = s;
	while (*p) p++;
	return (size_t)(p - s);
}

size_t strnlen(const char *s, size_t max) {
	size_t n = 0;
	while (n < max && s[n]) n++;
	return n;
}

int strcmp(const char *a, const char *b) {
	while (*a && *a == *b) {
		a++;
		b++;
	}
	return (unsigned char)*a - (unsigned char)*b;
}

int strncmp(const char *a, const char *b, size_t n) {
	for (; n; n--, a++, b++) {
		if (*a != *b) return (unsigned char)*a - (unsigned char)*b;
		if (!*a) return 0;
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
	const char *last = 0;
	for (;; s++) {
		if (*s == (char)c) last = s;
		if (!*s) return (char *)last;
	}
}

char *strstr(const char *haystack, const char *needle) {
	if (!*needle) return (char *)haystack;
	for (; *haystack; haystack++) {
		const char *a = haystack, *b = needle;
		while (*b && *a == *b) {
			a++;
			b++;
		}
		if (!*b) return (char *)haystack;
	}
	return 0;
}

char *strpbrk(const char *s, const char *accept) {
	for (; *s; s++)
		if (strchr(accept, *s)) return (char *)s;
	return 0;
}

size_t strspn(const char *s, const char *accept) {
	size_t n = 0;
	while (s[n] && strchr(accept, s[n])) n++;
	return n;
}

size_t strcspn(const char *s, const char *reject) {
	size_t n = 0;
	while (s[n] && !strchr(reject, s[n])) n++;
	return n;
}

char *strcpy(char *dst, const char *src) {
	char *d = dst;
	while ((*d++ = *src++))
		;
	return dst;
}

char *strncpy(char *dst, const char *src, size_t n) {
	size_t i = 0;
	for (; i < n && src[i]; i++) dst[i] = src[i];
	for (; i < n; i++) dst[i] = 0;
	return dst;
}

char *strcat(char *dst, const char *src) {
	strcpy(dst + strlen(dst), src);
	return dst;
}

char *strncat(char *dst, const char *src, size_t n) {
	size_t len = strlen(dst);
	size_t i = 0;
	for (; i < n && src[i]; i++) dst[len + i] = src[i];
	dst[len + i] = 0;
	return dst;
}

char *strdup(const char *s) {
	size_t n = strlen(s) + 1;
	char *p = malloc(n);
	if (p) memcpy(p, s, n);
	return p;
}

char *strerror(int code) {
	(void)code;
	return "unknown error";
}

int isalpha(int c) {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

int isdigit(int c) {
	return c >= '0' && c <= '9';
}

int isalnum(int c) {
	return isalpha(c) || isdigit(c);
}

int iscntrl(int c) {
	return (c >= 0 && c < 32) || c == 127;
}

int isgraph(int c) {
	return c > 32 && c < 127;
}

int isprint(int c) {
	return c >= 32 && c < 127;
}

int ispunct(int c) {
	return isgraph(c) && !isalnum(c);
}

int isspace(int c) {
	return c == ' ' || (c >= '\t' && c <= '\r');
}

int islower(int c) {
	return c >= 'a' && c <= 'z';
}

int isupper(int c) {
	return c >= 'A' && c <= 'Z';
}

int isxdigit(int c) {
	return isdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

int tolower(int c) {
	return isupper(c) ? c + 32 : c;
}

int toupper(int c) {
	return islower(c) ? c - 32 : c;
}

static int digit_value(int c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'z') return c - 'a' + 10;
	if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
	return 99;
}

static unsigned long long parse_magnitude(const char *s, char **end, int base, int *negative,
					  int *overflow) {
	const char *p = s;
	unsigned long long value = 0;
	int any = 0;
	*negative = 0;
	*overflow = 0;
	while (isspace((unsigned char)*p)) p++;
	if (*p == '+' || *p == '-') {
		*negative = *p == '-';
		p++;
	}
	if ((base == 0 || base == 16) && p[0] == '0' && (p[1] == 'x' || p[1] == 'X') &&
	    digit_value((unsigned char)p[2]) < 16) {
		p += 2;
		base = 16;
	}
	if (base == 0) base = p[0] == '0' ? 8 : 10;
	if (base < 2 || base > 36) {
		errno = EINVAL;
		if (end) *end = (char *)s;
		return 0;
	}
	for (; digit_value((unsigned char)*p) < base; p++) {
		unsigned digit = (unsigned)digit_value((unsigned char)*p);
		if (value > (ULLONG_MAX - digit) / (unsigned)base) *overflow = 1;
		else value = value * (unsigned)base + digit;
		any = 1;
	}
	if (end) *end = (char *)(any ? p : s);
	return value;
}

long strtol(const char *s, char **end, int base) {
	int negative, overflow;
	unsigned long long v = parse_magnitude(s, end, base, &negative, &overflow);
	unsigned long long limit = negative ? (unsigned long long)LONG_MAX + 1 : LONG_MAX;
	if (overflow || v > limit) {
		errno = ERANGE;
		return negative ? LONG_MIN : LONG_MAX;
	}
	return negative ? (long)(0 - v) : (long)v;
}

unsigned long strtoul(const char *s, char **end, int base) {
	int negative, overflow;
	unsigned long long v = parse_magnitude(s, end, base, &negative, &overflow);
	if (overflow || v > ULONG_MAX) {
		errno = ERANGE;
		return ULONG_MAX;
	}
	return negative ? (unsigned long)(0 - v) : (unsigned long)v;
}

long long strtoll(const char *s, char **end, int base) {
	int negative, overflow;
	unsigned long long v = parse_magnitude(s, end, base, &negative, &overflow);
	unsigned long long limit = negative ? (unsigned long long)LLONG_MAX + 1 : LLONG_MAX;
	if (overflow || v > limit) {
		errno = ERANGE;
		return negative ? LLONG_MIN : LLONG_MAX;
	}
	return negative ? (long long)(0 - v) : (long long)v;
}

unsigned long long strtoull(const char *s, char **end, int base) {
	int negative, overflow;
	unsigned long long v = parse_magnitude(s, end, base, &negative, &overflow);
	if (overflow) {
		errno = ERANGE;
		return ULLONG_MAX;
	}
	return negative ? 0 - v : v;
}

int atoi(const char *s) {
	return (int)strtol(s, 0, 10);
}

long atol(const char *s) {
	return strtol(s, 0, 10);
}

static const double exact_powers[23] = {
	1e0,  1e1,  1e2,  1e3,  1e4,  1e5,  1e6,  1e7,  1e8,  1e9,  1e10, 1e11,
	1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};

// fast path only: at most 15 significant digits and a decimal exponent in [-22, 22]
double strtod(const char *s, char **end) {
	const char *p = s;
	int negative = 0, significant = 0, any = 0, fraction = 0;
	uint64_t mantissa = 0;
	long exponent = 0;
	long exp10 = 0;

	while (isspace((unsigned char)*p)) p++;
	if (*p == '+' || *p == '-') {
		negative = *p == '-';
		p++;
	}
	if ((p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) || tolower((unsigned char)p[0]) == 'i' ||
	    tolower((unsigned char)p[0]) == 'n') {
		errno = EINVAL;
		if (end) *end = (char *)s;
		return 0;
	}
	for (; isdigit((unsigned char)*p) || (*p == '.' && !fraction); p++) {
		if (*p == '.') {
			fraction = 1;
			continue;
		}
		any = 1;
		if (mantissa == 0 && *p == '0') {
			if (fraction) exp10--;
			continue;
		}
		if (significant == 15) {
			errno = ERANGE;
			if (end) *end = (char *)s;
			return 0;
		}
		mantissa = mantissa * 10 + (uint64_t)(*p - '0');
		significant++;
		if (fraction) exp10--;
	}
	if (!any) {
		if (end) *end = (char *)s;
		return 0;
	}
	if (*p == 'e' || *p == 'E') {
		const char *q = p + 1;
		int exp_negative = 0;
		if (*q == '+' || *q == '-') {
			exp_negative = *q == '-';
			q++;
		}
		if (isdigit((unsigned char)*q)) {
			for (; isdigit((unsigned char)*q); q++)
				if (exponent < 100000) exponent = exponent * 10 + (*q - '0');
			if (exp_negative) exponent = -exponent;
			p = q;
		}
	}
	if (mantissa == 0) {
		if (end) *end = (char *)p;
		return negative ? -0.0 : 0.0;
	}
	long e = exp10 + exponent;
	if (e > 22 || e < -22) {
		errno = ERANGE;
		if (end) *end = (char *)s;
		return 0;
	}
	if (end) *end = (char *)p;
	double v = e >= 0 ? (double)mantissa * exact_powers[e] : (double)mantissa / exact_powers[-e];
	return negative ? -v : v;
}

double atof(const char *s) {
	return strtod(s, 0);
}

static void swap_elements(unsigned char *a, unsigned char *b, size_t size) {
	while (size--) {
		unsigned char t = *a;
		*a++ = *b;
		*b++ = t;
	}
}

static void sift_down(unsigned char *base, size_t root, size_t count, size_t size,
		      int (*cmp)(const void *, const void *)) {
	for (;;) {
		size_t child = 2 * root + 1;
		if (child >= count) return;
		if (child + 1 < count && cmp(base + child * size, base + (child + 1) * size) < 0) child++;
		if (cmp(base + root * size, base + child * size) >= 0) return;
		swap_elements(base + root * size, base + child * size, size);
		root = child;
	}
}

// heapsort: not stable, n log n worst case, no allocation
void qsort(void *base, size_t count, size_t size, int (*cmp)(const void *, const void *)) {
	unsigned char *p = base;
	if (count < 2 || size == 0) return;
	for (size_t i = count / 2; i-- > 0;) sift_down(p, i, count, size, cmp);
	for (size_t end = count - 1; end > 0; end--) {
		swap_elements(p, p + end * size, size);
		sift_down(p, 0, end, size, cmp);
	}
}

void *bsearch(const void *key, const void *base, size_t count, size_t size,
	      int (*cmp)(const void *, const void *)) {
	const unsigned char *p = base;
	size_t lo = 0, hi = count;
	while (lo < hi) {
		size_t mid = lo + (hi - lo) / 2;
		int c = cmp(key, p + mid * size);
		if (c == 0) return (void *)(p + mid * size);
		if (c < 0) hi = mid;
		else lo = mid + 1;
	}
	return 0;
}

struct sink {
	char *buf;
	size_t cap;
	size_t len;
};

static void put_char(struct sink *s, char c) {
	if (s->len + 1 < s->cap) s->buf[s->len] = c;
	s->len++;
}

static void put_repeat(struct sink *s, char c, size_t n) {
	for (; n; n--) put_char(s, c);
}

// zero padding goes after a leading sign
static void put_field(struct sink *s, const char *body, size_t n, int width, int left, int zero) {
	size_t pad = (size_t)width > n ? (size_t)width - n : 0;
	size_t i = 0;
	if (left) {
		for (; i < n; i++) put_char(s, body[i]);
		put_repeat(s, ' ', pad);
		return;
	}
	if (zero && n && body[0] == '-') {
		put_char(s, '-');
		i = 1;
	}
	put_repeat(s, zero ? '0' : ' ', pad);
	for (; i < n; i++) put_char(s, body[i]);
}

static void mul_small_limbs(uint32_t *limb, int *count, uint32_t factor) {
	uint64_t carry = 0;
	for (int i = 0; i < *count; i++) {
		uint64_t t = (uint64_t)limb[i] * factor + carry;
		limb[i] = (uint32_t)(t % 1000000000u);
		carry = t / 1000000000u;
	}
	while (carry) {
		limb[(*count)++] = (uint32_t)(carry % 1000000000u);
		carry /= 1000000000u;
	}
}

// exact decimal expansion of a positive finite double: value = digits * 10^shift
#define MAX_DIGITS 810

static void exact_decimal(double v, char *digits, int *count, int *exp10) {
	union {
		double d;
		uint64_t u;
	} bits;
	bits.d = v;
	int biased = (int)((bits.u >> 52) & 0x7ff);
	uint64_t m = bits.u & ((1ull << 52) - 1);
	if (biased) m |= 1ull << 52;
	else biased = 1;
	int e2 = biased - 1075;

	uint32_t limb[90];
	int n = 0;
	do {
		limb[n++] = (uint32_t)(m % 1000000000u);
		m /= 1000000000u;
	} while (m);

	int shift = 0;
	if (e2 >= 0) {
		for (int k = e2; k > 0;) {
			int step = k < 29 ? k : 29;
			mul_small_limbs(limb, &n, 1u << step);
			k -= step;
		}
	} else {
		for (int k = -e2; k > 0;) {
			int step = k < 13 ? k : 13;
			uint32_t factor = 1;
			for (int i = 0; i < step; i++) factor *= 5;
			mul_small_limbs(limb, &n, factor);
			k -= step;
		}
		shift = e2;
	}

	char raw[9 * 90];
	int r = 0;
	for (int i = n - 1; i >= 0; i--) {
		uint32_t t = limb[i];
		for (int d = 8; d >= 0; d--, t /= 10) raw[r + d] = (char)('0' + t % 10);
		r += 9;
	}
	int start = 0;
	while (start < r - 1 && raw[start] == '0') start++;
	*count = r - start;
	memcpy(digits, raw + start, (size_t)*count);
	while (*count > 1 && digits[*count - 1] == '0') {
		(*count)--;
		shift++;
	}
	*exp10 = (*count - 1) + shift;
}

// round to keep significant digits, half to even on the exact value; returns 1 on a carry out
static int round_digits(const char *all, int total, int keep, char *out) {
	for (int i = 0; i < keep; i++) out[i] = i < total ? all[i] : '0';
	int next = keep < total ? all[keep] - '0' : 0;
	int tail = 0;
	for (int i = keep + 1; i < total; i++)
		if (all[i] != '0') {
			tail = 1;
			break;
		}
	int last_odd = (out[keep - 1] - '0') & 1;
	if (next > 5 || (next == 5 && (tail || last_odd))) {
		int i = keep - 1;
		for (; i >= 0 && out[i] == '9'; i--) out[i] = '0';
		if (i >= 0) {
			out[i]++;
			return 0;
		}
		out[0] = '1';
		return 1;
	}
	return 0;
}

static size_t format_g(double v, int precision, char *out) {
	size_t n = 0;
	if (isnan(v)) {
		memcpy(out, "nan", 4);
		return 3;
	}
	if (signbit(v)) out[n++] = '-';
	v = fabs(v);
	if (isinf(v)) {
		memcpy(out + n, "inf", 4);
		return n + 3;
	}
	if (v == 0) {
		out[n++] = '0';
		out[n] = 0;
		return n;
	}
	int p = precision == 0 ? 1 : precision;
	char all[MAX_DIGITS];
	int total, x;
	exact_decimal(v, all, &total, &x);
	char digits[MAX_DIGITS];
	x += round_digits(all, total, p, digits);
	int nd = p;
	while (nd > 1 && digits[nd - 1] == '0') nd--;

	if (x < -4 || x >= p) {
		out[n++] = digits[0];
		if (nd > 1) {
			out[n++] = '.';
			for (int i = 1; i < nd; i++) out[n++] = digits[i];
		}
		out[n++] = 'e';
		out[n++] = x < 0 ? '-' : '+';
		int a = x < 0 ? -x : x;
		char eb[8];
		int ne = 0;
		do {
			eb[ne++] = (char)('0' + a % 10);
			a /= 10;
		} while (a);
		if (ne < 2) eb[ne++] = '0';
		while (ne) out[n++] = eb[--ne];
	} else if (x >= 0) {
		for (int i = 0; i <= x; i++) out[n++] = digits[i];
		if (nd > x + 1) {
			out[n++] = '.';
			for (int i = x + 1; i < nd; i++) out[n++] = digits[i];
		}
	} else {
		out[n++] = '0';
		out[n++] = '.';
		for (int i = 0; i < -x - 1; i++) out[n++] = '0';
		for (int i = 0; i < nd; i++) out[n++] = digits[i];
	}
	out[n] = 0;
	return n;
}

// supported: %d %i %u %x %X %c %s %g %% with flags - and 0, width, precision for %s and %g,
// lengths l ll z, and * for width or precision. Anything else returns -1 with errno EINVAL.
static int format(struct sink *s, const char *f, va_list ap) {
	for (; *f; f++) {
		if (*f != '%') {
			put_char(s, *f);
			continue;
		}
		if (*++f == '%') {
			put_char(s, '%');
			continue;
		}
		int left = 0, zero = 0, width = 0, precision = -1, lenmod = 0;
		for (;; f++) {
			if (*f == '-') left = 1;
			else if (*f == '0') zero = 1;
			else break;
		}
		if (*f == '*') {
			width = va_arg(ap, int);
			if (width < 0) {
				left = 1;
				width = -width;
			}
			f++;
		} else {
			for (; isdigit((unsigned char)*f); f++) width = width * 10 + (*f - '0');
		}
		if (*f == '.') {
			f++;
			precision = 0;
			if (*f == '*') {
				precision = va_arg(ap, int);
				f++;
			} else {
				for (; isdigit((unsigned char)*f); f++) precision = precision * 10 + (*f - '0');
			}
		}
		if (*f == 'l') {
			f++;
			lenmod = 1;
			if (*f == 'l') {
				f++;
				lenmod = 2;
			}
		} else if (*f == 'z') {
			f++;
			lenmod = 3;
		}
		char conv = *f;
		if (conv == 'd' || conv == 'i' || conv == 'u' || conv == 'x' || conv == 'X' || conv == 'c') {
			if (conv != 'c' && precision >= 0) {
				errno = EINVAL;
				return -1;
			}
		}
		switch (conv) {
		case 'd':
		case 'i': {
			long long v;
			if (lenmod == 2) v = va_arg(ap, long long);
			else if (lenmod == 1) v = va_arg(ap, long);
			else if (lenmod == 3) v = va_arg(ap, ptrdiff_t);
			else v = va_arg(ap, int);
			char body[24];
			int n = 0;
			unsigned long long mag = v < 0 ? 0ull - (unsigned long long)v : (unsigned long long)v;
			do {
				body[n++] = (char)('0' + mag % 10);
				mag /= 10;
			} while (mag);
			if (v < 0) body[n++] = '-';
			char out[24];
			for (int i = 0; i < n; i++) out[i] = body[n - 1 - i];
			put_field(s, out, (size_t)n, width, left, zero);
			break;
		}
		case 'u':
		case 'x':
		case 'X': {
			unsigned long long v;
			if (lenmod == 2) v = va_arg(ap, unsigned long long);
			else if (lenmod == 1) v = va_arg(ap, unsigned long);
			else if (lenmod == 3) v = va_arg(ap, size_t);
			else v = va_arg(ap, unsigned int);
			unsigned base = conv == 'u' ? 10u : 16u;
			const char *alphabet = conv == 'X' ? "0123456789ABCDEF" : "0123456789abcdef";
			char body[24];
			int n = 0;
			do {
				body[n++] = alphabet[v % base];
				v /= base;
			} while (v);
			char out[24];
			for (int i = 0; i < n; i++) out[i] = body[n - 1 - i];
			put_field(s, out, (size_t)n, width, left, zero);
			break;
		}
		case 'c': {
			char c = (char)va_arg(ap, int);
			put_field(s, &c, 1, width, left, 0);
			break;
		}
		case 's': {
			const char *str = va_arg(ap, const char *);
			if (!str) str = "(null)";
			size_t n = precision >= 0 ? strnlen(str, (size_t)precision) : strlen(str);
			put_field(s, str, n, width, left, 0);
			break;
		}
		case 'g': {
			double v = va_arg(ap, double);
			if (precision > 700) {
				errno = EINVAL;
				return -1;
			}
			char out[MAX_DIGITS + 8];
			size_t n = format_g(v, precision < 0 ? 6 : precision, out);
			put_field(s, out, n, width, left, zero);
			break;
		}
		default:
			errno = EINVAL;
			return -1;
		}
	}
	return 0;
}

int vsnprintf(char *buf, size_t cap, const char *fmt, va_list ap) {
	struct sink s = {buf, cap, 0};
	int status = format(&s, fmt, ap);
	if (cap) buf[s.len < cap ? s.len : cap - 1] = 0;
	if (status < 0) return -1;
	return (int)s.len;
}

int snprintf(char *buf, size_t cap, const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(buf, cap, fmt, ap);
	va_end(ap);
	return n;
}

int vsprintf(char *buf, const char *fmt, va_list ap) {
	return vsnprintf(buf, SIZE_MAX, fmt, ap);
}

int sprintf(char *buf, const char *fmt, ...) {
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(buf, SIZE_MAX, fmt, ap);
	va_end(ap);
	return n;
}

int printf(const char *fmt, ...) {
	(void)fmt;
	errno = ENOSYS;
	return -1;
}

int vprintf(const char *fmt, va_list ap) {
	(void)fmt;
	(void)ap;
	errno = ENOSYS;
	return -1;
}

int fprintf(FILE *f, const char *fmt, ...) {
	(void)f;
	(void)fmt;
	errno = ENOSYS;
	return -1;
}

int vfprintf(FILE *f, const char *fmt, va_list ap) {
	(void)f;
	(void)fmt;
	(void)ap;
	errno = ENOSYS;
	return -1;
}

int sscanf(const char *src, const char *fmt, ...) {
	(void)src;
	(void)fmt;
	errno = ENOSYS;
	return EOF;
}

int puts(const char *s) {
	(void)s;
	errno = ENOSYS;
	return EOF;
}

int fputs(const char *s, FILE *f) {
	(void)s;
	(void)f;
	errno = ENOSYS;
	return EOF;
}

int fputc(int c, FILE *f) {
	(void)c;
	(void)f;
	errno = ENOSYS;
	return EOF;
}

int putc(int c, FILE *f) {
	return fputc(c, f);
}

int putchar(int c) {
	(void)c;
	errno = ENOSYS;
	return EOF;
}

int fgetc(FILE *f) {
	(void)f;
	errno = ENOSYS;
	return EOF;
}

int getc(FILE *f) {
	return fgetc(f);
}

int ungetc(int c, FILE *f) {
	(void)c;
	(void)f;
	errno = ENOSYS;
	return EOF;
}

char *fgets(char *buf, int n, FILE *f) {
	(void)buf;
	(void)n;
	(void)f;
	errno = ENOSYS;
	return 0;
}

size_t fread(void *buf, size_t size, size_t count, FILE *f) {
	(void)buf;
	(void)size;
	(void)count;
	(void)f;
	errno = ENOSYS;
	return 0;
}

size_t fwrite(const void *buf, size_t size, size_t count, FILE *f) {
	(void)buf;
	(void)size;
	(void)count;
	(void)f;
	errno = ENOSYS;
	return 0;
}

FILE *fopen(const char *path, const char *mode) {
	(void)path;
	(void)mode;
	errno = ENOSYS;
	return 0;
}

int fclose(FILE *f) {
	(void)f;
	errno = ENOSYS;
	return EOF;
}

int fflush(FILE *f) {
	(void)f;
	errno = ENOSYS;
	return EOF;
}

int feof(FILE *f) {
	(void)f;
	return 0;
}

int ferror(FILE *f) {
	(void)f;
	return 1;
}

int fseek(FILE *f, long offset, int whence) {
	(void)f;
	(void)offset;
	(void)whence;
	errno = ENOSYS;
	return -1;
}

long ftell(FILE *f) {
	(void)f;
	errno = ENOSYS;
	return -1;
}

void rewind(FILE *f) {
	(void)f;
	errno = ENOSYS;
}

time_t time(time_t *out) {
	(void)out;
	errno = ENOSYS;
	return (time_t)-1;
}

clock_t clock(void) {
	errno = ENOSYS;
	return (clock_t)-1;
}

double difftime(time_t end, time_t begin) {
	return (double)(end - begin);
}

time_t mktime(struct tm *tm) {
	(void)tm;
	errno = ENOSYS;
	return (time_t)-1;
}

struct tm *gmtime(const time_t *t) {
	(void)t;
	errno = ENOSYS;
	return 0;
}

struct tm *localtime(const time_t *t) {
	(void)t;
	errno = ENOSYS;
	return 0;
}

size_t strftime(char *buf, size_t cap, const char *fmt, const struct tm *tm) {
	(void)buf;
	(void)cap;
	(void)fmt;
	(void)tm;
	errno = ENOSYS;
	return 0;
}

int gettimeofday(struct timeval *tv, struct timezone *tz) {
	(void)tv;
	(void)tz;
	errno = ENOSYS;
	return -1;
}

int clock_gettime(clockid_t clock, struct timespec *ts) {
	(void)clock;
	(void)ts;
	errno = ENOSYS;
	return -1;
}

pid_t getpid(void) {
	errno = ENOSYS;
	return -1;
}

int isatty(int fd) {
	(void)fd;
	errno = ENOSYS;
	return 0;
}

int close(int fd) {
	(void)fd;
	errno = ENOSYS;
	return -1;
}

ssize_t read(int fd, void *buf, size_t count) {
	(void)fd;
	(void)buf;
	(void)count;
	errno = ENOSYS;
	return -1;
}

ssize_t write(int fd, const void *buf, size_t count) {
	(void)fd;
	(void)buf;
	(void)count;
	errno = ENOSYS;
	return -1;
}

int open(const char *path, int flags, ...) {
	(void)path;
	(void)flags;
	errno = ENOSYS;
	return -1;
}

int stat(const char *path, struct stat *st) {
	(void)path;
	(void)st;
	errno = ENOSYS;
	return -1;
}

int fstat(int fd, struct stat *st) {
	(void)fd;
	(void)st;
	errno = ENOSYS;
	return -1;
}

char *realpath(const char *path, char *resolved) {
	(void)path;
	(void)resolved;
	errno = ENOSYS;
	return 0;
}

// threads are not available: every call that would start or wait on one returns ENOSYS
int pthread_once(pthread_once_t *once, void (*routine)(void)) {
	(void)once;
	(void)routine;
	return ENOSYS;
}

int pthread_attr_init(pthread_attr_t *attr) {
	(void)attr;
	return 0;
}

int pthread_attr_destroy(pthread_attr_t *attr) {
	(void)attr;
	return 0;
}

int pthread_attr_setdetachstate(pthread_attr_t *attr, int state) {
	(void)attr;
	(void)state;
	return 0;
}

int pthread_attr_setstacksize(pthread_attr_t *attr, size_t size) {
	(void)attr;
	(void)size;
	return 0;
}

int pthread_mutex_init(pthread_mutex_t *mutex, const pthread_mutexattr_t *attr) {
	(void)mutex;
	(void)attr;
	return ENOSYS;
}

int pthread_mutex_destroy(pthread_mutex_t *mutex) {
	(void)mutex;
	return ENOSYS;
}

int pthread_mutex_lock(pthread_mutex_t *mutex) {
	(void)mutex;
	return ENOSYS;
}

int pthread_mutex_unlock(pthread_mutex_t *mutex) {
	(void)mutex;
	return ENOSYS;
}

int pthread_condattr_init(pthread_condattr_t *attr) {
	(void)attr;
	return 0;
}

int pthread_condattr_destroy(pthread_condattr_t *attr) {
	(void)attr;
	return 0;
}

int pthread_condattr_setclock(pthread_condattr_t *attr, clockid_t clock) {
	(void)attr;
	(void)clock;
	return 0;
}

int pthread_cond_init(pthread_cond_t *cond, const pthread_condattr_t *attr) {
	(void)cond;
	(void)attr;
	return ENOSYS;
}

int pthread_cond_destroy(pthread_cond_t *cond) {
	(void)cond;
	return ENOSYS;
}

int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex) {
	(void)cond;
	(void)mutex;
	return ENOSYS;
}

int pthread_cond_timedwait(pthread_cond_t *cond, pthread_mutex_t *mutex,
			   const struct timespec *abstime) {
	(void)cond;
	(void)mutex;
	(void)abstime;
	return ENOSYS;
}

int pthread_cond_signal(pthread_cond_t *cond) {
	(void)cond;
	return ENOSYS;
}

int pthread_cond_broadcast(pthread_cond_t *cond) {
	(void)cond;
	return ENOSYS;
}

int pthread_create(pthread_t *thread, const pthread_attr_t *attr, void *(*start)(void *),
		   void *arg) {
	(void)thread;
	(void)attr;
	(void)start;
	(void)arg;
	return ENOSYS;
}

int pthread_join(pthread_t thread, void **result) {
	(void)thread;
	(void)result;
	return ENOSYS;
}

size_t wcslen(const wchar_t *s) {
	const wchar_t *p = s;
	while (*p) p++;
	return (size_t)(p - s);
}

int wcsncmp(const wchar_t *a, const wchar_t *b, size_t n) {
	for (; n; n--, a++, b++) {
		if (*a != *b) return *a < *b ? -1 : 1;
		if (!*a) return 0;
	}
	return 0;
}

// no locale conversion: every multibyte conversion fails with (size_t)-1
size_t wcrtomb(char *s, wchar_t wc, mbstate_t *state) {
	(void)s;
	(void)wc;
	(void)state;
	errno = ENOSYS;
	return (size_t)-1;
}

size_t mbrtowc(wchar_t *pwc, const char *s, size_t n, mbstate_t *state) {
	(void)pwc;
	(void)s;
	(void)n;
	(void)state;
	errno = ENOSYS;
	return (size_t)-1;
}

size_t wcstombs(char *s, const wchar_t *pwcs, size_t n) {
	(void)s;
	(void)pwcs;
	(void)n;
	errno = ENOSYS;
	return (size_t)-1;
}

size_t wcsrtombs(char *s, const wchar_t **src, size_t n, mbstate_t *state) {
	(void)s;
	(void)src;
	(void)n;
	(void)state;
	errno = ENOSYS;
	return (size_t)-1;
}

double sqrt(double x) {
	return __builtin_sqrt(x);
}

double fabs(double x) {
	return __builtin_fabs(x);
}

double copysign(double x, double y) {
	return __builtin_copysign(x, y);
}

double floor(double x) {
	return __builtin_floor(x);
}

double ceil(double x) {
	return __builtin_ceil(x);
}

float sqrtf(float x) {
	return __builtin_sqrtf(x);
}

float fabsf(float x) {
	return __builtin_fabsf(x);
}

float floorf(float x) {
	return __builtin_floorf(x);
}

float ceilf(float x) {
	return __builtin_ceilf(x);
}
