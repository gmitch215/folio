#ifndef SHIM_ASSERT_H
#define SHIM_ASSERT_H

#ifdef NDEBUG
#define assert(x) ((void)0)
#else
#define assert(x) ((x) ? (void)0 : __builtin_trap())
#endif

#define static_assert _Static_assert

#endif
