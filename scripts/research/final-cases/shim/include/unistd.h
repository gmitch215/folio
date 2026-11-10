#ifndef SHIM_UNISTD_H
#define SHIM_UNISTD_H

#include <stddef.h>
#include <sys/types.h>

#define STDIN_FILENO 0
#define STDOUT_FILENO 1
#define STDERR_FILENO 2

typedef int pid_t;

pid_t getpid(void);
int isatty(int);
int close(int);
ssize_t read(int, void *, size_t);
ssize_t write(int, const void *, size_t);

#endif
