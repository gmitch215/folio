#ifndef SHIM_MATH_H
#define SHIM_MATH_H

#include <features.h>
#include <float.h>

#if FLT_EVAL_METHOD == 0
typedef float float_t;
typedef double double_t;
#else
#error "shim math.h supports FLT_EVAL_METHOD 0 only"
#endif

#define M_PI 3.14159265358979323846
#define M_PI_2 1.57079632679489661923
#define HUGE_VAL __builtin_huge_val()
#define HUGE_VALF __builtin_huge_valf()

#define isnan(x) __builtin_isnan(x)
#define isinf(x) __builtin_isinf(x)
#define isfinite(x) __builtin_isfinite(x)
#define signbit(x) __builtin_signbit(x)

#define FP_NAN 0
#define FP_INFINITE 1
#define FP_ZERO 2
#define FP_SUBNORMAL 3
#define FP_NORMAL 4
#define fpclassify(x) __builtin_fpclassify(FP_NAN, FP_INFINITE, FP_NORMAL, FP_SUBNORMAL, FP_ZERO, x)

double sin(double);
double cos(double);
double pow(double, double);
double log(double);
double exp(double);
double sqrt(double);
double floor(double);
double ceil(double);
double fabs(double);
double scalbn(double, int);
double ldexp(double, int);
double copysign(double, double);

float sinf(float);
float cosf(float);
float powf(float, float);
float logf(float);
float expf(float);
float sqrtf(float);
float floorf(float);
float ceilf(float);
float fabsf(float);

#endif
