#ifndef SHIM_TIME_H
#define SHIM_TIME_H

#include <stddef.h>

typedef long long time_t;
typedef long clock_t;
typedef int clockid_t;

#define CLOCKS_PER_SEC 1000000L
#define CLOCK_REALTIME 0
#define CLOCK_MONOTONIC 1

struct timespec {
	time_t tv_sec;
	long tv_nsec;
};

struct tm {
	int tm_sec;
	int tm_min;
	int tm_hour;
	int tm_mday;
	int tm_mon;
	int tm_year;
	int tm_wday;
	int tm_yday;
	int tm_isdst;
};

time_t time(time_t *);
clock_t clock(void);
int clock_gettime(clockid_t, struct timespec *);
double difftime(time_t, time_t);
time_t mktime(struct tm *);
struct tm *gmtime(const time_t *);
struct tm *localtime(const time_t *);
size_t strftime(char *, size_t, const char *, const struct tm *);

#endif
