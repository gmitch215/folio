#ifndef SHIM_ERRNO_H
#define SHIM_ERRNO_H

#define EPERM 1
#define ENOENT 2
#define EIO 5
#define ENOMEM 12
#define EACCES 13
#define EEXIST 17
#define EINVAL 22
#define ENOSPC 28
#define EDOM 33
#define ERANGE 34
#define ENOSYS 38

extern int errno;

#endif
