#pragma once
#include_next <stdio.h>
#include <stddef.h>
extern FILE *stderr;
int snprintf(char *, size_t, const char *, ...);
int fprintf(FILE *, const char *, ...);
