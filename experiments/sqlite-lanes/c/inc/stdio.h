#pragma once
#include <stddef.h>
typedef struct folio_file FILE;
int snprintf(char *, size_t, const char *, ...);
int sprintf(char *, const char *, ...);
int fprintf(FILE *, const char *, ...);
int printf(const char *, ...);
