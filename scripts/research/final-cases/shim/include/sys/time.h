#ifndef SHIM_SYS_TIME_H
#define SHIM_SYS_TIME_H

#include <time.h>

struct timeval {
	time_t tv_sec;
	long tv_usec;
};

struct timezone {
	int tz_minuteswest;
	int tz_dsttime;
};

int gettimeofday(struct timeval *, struct timezone *);

#endif
