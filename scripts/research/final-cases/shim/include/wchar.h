#ifndef SHIM_WCHAR_H
#define SHIM_WCHAR_H

#include <stddef.h>

typedef __WCHAR_TYPE__ wchar_t;
typedef __WINT_TYPE__ wint_t;
typedef struct {
	int count;
	unsigned int value;
} mbstate_t;

#define WEOF ((wint_t)-1)

size_t wcslen(const wchar_t *);
int wcsncmp(const wchar_t *, const wchar_t *, size_t);
size_t wcrtomb(char *, wchar_t, mbstate_t *);
size_t mbrtowc(wchar_t *, const char *, size_t, mbstate_t *);
size_t wcstombs(char *, const wchar_t *, size_t);
size_t wcsrtombs(char *, const wchar_t **, size_t, mbstate_t *);

#endif
