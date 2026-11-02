| driver | native parallel-for | best wasm mode | wasm best over native |
| --- | ---: | ---: | ---: |
| aes-cbc-decrypt | 3.63 | 3.88 | 1.07 |
| aes-cbc-decrypt-shared | 2.52 | 3.47 | 1.38 |
| aes-cbc-encrypt | 3.47 | 3.24 | 0.93 |
| aes-cbc-encrypt-slot | 3.86 | 3.64 | 0.94 |
| aes-ctr | 3.39 | 3.54 | 1.05 |
| blake2b | 5.61 | 3.46 | 0.62 |
| brotli-compress | 3.64 | 3.94 | 1.08 |
| brotli-decompress | 2.77 | 2.85 | 1.03 |
| jsmn-parse | 2.27 | 2.99 | 1.31 |
| jsmn-parse-shared | 3.62 | 2.04 | 0.56 |
| jsmn-parse-slot | 3.95 | 2.92 | 0.74 |
| kissfft-complex | 2.82 | 2.81 | 0.99 |
| kissfft-real | 3.70 | 3.31 | 0.89 |
| kissfft-real-shared | not equal | 1.93 | - |
| lz4-compress | 2.32 | 3.30 | 1.42 |
| lz4-decompress | 3.49 | 2.24 | 0.64 |
| m6502 | 2.75 | 3.31 | 1.20 |
| md4c-html | 3.94 | 3.27 | 0.83 |
| md5 | 3.96 | 3.75 | 0.95 |
| md5-slot | 3.27 | 3.47 | 1.06 |
| miniz-adler32 | 3.06 | 2.58 | 0.84 |
| miniz-compress | 3.19 | 2.97 | 0.93 |
| miniz-crc32 | 3.57 | 3.34 | 0.93 |
| miniz-decompress | 2.64 | 2.36 | 0.89 |
| qoa-decode | 3.46 | 2.17 | 0.63 |
| qoa-encode | 3.44 | 3.96 | 1.15 |
| qoi-decode | 3.85 | 1.61 | 0.42 |
| qoi-decode-64 | 3.69 | 1.91 | 0.52 |
| qoi-encode | 3.95 | 1.48 | 0.38 |
| qoi-encode-64 | 3.73 | 1.57 | 0.42 |
| sha1 | 3.91 | 3.56 | 0.91 |
| sha256 | 5.43 | 3.43 | 0.63 |
| sha256-shared | 3.72 | 3.18 | 0.86 |
| wyhash | 1.44 | 3.12 | 2.16 |
| xxhash3 | 4.48 | 2.69 | 0.60 |
| xxhash32 | 3.63 | 2.13 | 0.59 |
| xxhash64 | 6.39 | 1.94 | 0.30 |
| yyjson-read | 3.73 | 1.96 | 0.52 |

Geometric mean over the 37 drivers with equal native output: native parallel-for 3.46, best exact wasm mode 2.80, wasm over native 0.81.
Drivers with native speedup above 2: 36 of 37; with the best wasm mode above 2: 31.
