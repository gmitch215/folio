## Sweeps to the fixed point (sweep = pass, warm pre-pass included)

| subject | input | MiB | K | guess | sweeps | loop passes | chunk runs | equal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| utf8flag | random | 0.0625 | 8 | zero | 2 | 2 | 15 | true |
| utf8flag | random | 0.0625 | 8 | warm | 3 | 2 | 20 | true |
| utf8flag | random | 0.0625 | 32 | zero | 2 | 2 | 63 | true |
| utf8flag | random | 0.0625 | 32 | warm | 3 | 2 | 80 | true |
| utf8flag | text | 0.0625 | 8 | zero | 1 | 1 | 8 | true |
| utf8flag | text | 0.0625 | 8 | warm | 2 | 1 | 16 | true |
| utf8flag | text | 0.0625 | 32 | zero | 8 | 8 | 45 | true |
| utf8flag | text | 0.0625 | 32 | warm | 10 | 9 | 79 | true |
| utf8flag | adv | 0.0625 | 8 | zero | 2 | 2 | 15 | true |
| utf8flag | adv | 0.0625 | 8 | warm | 3 | 2 | 17 | true |
| utf8flag | adv | 0.0625 | 32 | zero | 2 | 2 | 63 | true |
| utf8flag | adv | 0.0625 | 32 | warm | 3 | 2 | 66 | true |
| utf8flag | random | 1 | 8 | zero | 2 | 2 | 15 | true |
| utf8flag | random | 1 | 8 | warm | 3 | 2 | 17 | true |
| utf8flag | random | 1 | 32 | zero | 2 | 2 | 63 | true |
| utf8flag | random | 1 | 32 | warm | 3 | 2 | 78 | true |
| utf8flag | text | 1 | 8 | zero | 1 | 1 | 8 | true |
| utf8flag | text | 1 | 8 | warm | 2 | 1 | 16 | true |
| utf8flag | text | 1 | 32 | zero | 1 | 1 | 32 | true |
| utf8flag | text | 1 | 32 | warm | 2 | 1 | 64 | true |
| utf8flag | adv | 1 | 8 | zero | 2 | 2 | 15 | true |
| utf8flag | adv | 1 | 8 | warm | 3 | 2 | 17 | true |
| utf8flag | adv | 1 | 32 | zero | 2 | 2 | 63 | true |
| utf8flag | adv | 1 | 32 | warm | 3 | 2 | 66 | true |
| utf8flag | random | 64 | 8 | zero | 2 | 2 | 15 | true |
| utf8flag | random | 64 | 8 | warm | 3 | 2 | 19 | true |
| utf8flag | random | 64 | 32 | zero | 2 | 2 | 63 | true |
| utf8flag | random | 64 | 32 | warm | 3 | 2 | 74 | true |
| utf8flag | text | 64 | 8 | zero | 1 | 1 | 8 | true |
| utf8flag | text | 64 | 8 | warm | 2 | 1 | 16 | true |
| utf8flag | text | 64 | 32 | zero | 1 | 1 | 32 | true |
| utf8flag | text | 64 | 32 | warm | 2 | 1 | 64 | true |
| utf8flag | adv | 64 | 8 | zero | 2 | 2 | 15 | true |
| utf8flag | adv | 64 | 8 | warm | 3 | 2 | 17 | true |
| utf8flag | adv | 64 | 32 | zero | 2 | 2 | 63 | true |
| utf8flag | adv | 64 | 32 | warm | 3 | 2 | 66 | true |
| utf8dfa | random | 0.0625 | 8 | zero | 2 | 2 | 10 | true |
| utf8dfa | random | 0.0625 | 8 | warm | 3 | 2 | 20 | true |
| utf8dfa | random | 0.0625 | 32 | zero | 2 | 2 | 41 | true |
| utf8dfa | random | 0.0625 | 32 | warm | 3 | 2 | 80 | true |
| utf8dfa | text | 0.0625 | 8 | zero | 1 | 1 | 8 | true |
| utf8dfa | text | 0.0625 | 8 | warm | 2 | 1 | 16 | true |
| utf8dfa | text | 0.0625 | 32 | zero | 2 | 2 | 33 | true |
| utf8dfa | text | 0.0625 | 32 | warm | 3 | 2 | 66 | true |
| utf8dfa | adv | 0.0625 | 8 | zero | 2 | 2 | 15 | true |
| utf8dfa | adv | 0.0625 | 8 | warm | 3 | 2 | 17 | true |
| utf8dfa | adv | 0.0625 | 32 | zero | 2 | 2 | 63 | true |
| utf8dfa | adv | 0.0625 | 32 | warm | 3 | 2 | 65 | true |
| utf8dfa | random | 1 | 8 | zero | 2 | 2 | 9 | true |
| utf8dfa | random | 1 | 8 | warm | 3 | 2 | 17 | true |
| utf8dfa | random | 1 | 32 | zero | 2 | 2 | 40 | true |
| utf8dfa | random | 1 | 32 | warm | 3 | 2 | 78 | true |
| utf8dfa | text | 1 | 8 | zero | 1 | 1 | 8 | true |
| utf8dfa | text | 1 | 8 | warm | 2 | 1 | 16 | true |
| utf8dfa | text | 1 | 32 | zero | 1 | 1 | 32 | true |
| utf8dfa | text | 1 | 32 | warm | 2 | 1 | 64 | true |
| utf8dfa | adv | 1 | 8 | zero | 2 | 2 | 15 | true |
| utf8dfa | adv | 1 | 8 | warm | 3 | 2 | 17 | true |
| utf8dfa | adv | 1 | 32 | zero | 2 | 2 | 63 | true |
| utf8dfa | adv | 1 | 32 | warm | 3 | 2 | 65 | true |
| utf8dfa | random | 64 | 8 | zero | 2 | 2 | 11 | true |
| utf8dfa | random | 64 | 8 | warm | 3 | 2 | 19 | true |
| utf8dfa | random | 64 | 32 | zero | 2 | 2 | 38 | true |
| utf8dfa | random | 64 | 32 | warm | 3 | 2 | 74 | true |
| utf8dfa | text | 64 | 8 | zero | 1 | 1 | 8 | true |
| utf8dfa | text | 64 | 8 | warm | 2 | 1 | 16 | true |
| utf8dfa | text | 64 | 32 | zero | 1 | 1 | 32 | true |
| utf8dfa | text | 64 | 32 | warm | 2 | 1 | 64 | true |
| utf8dfa | adv | 64 | 8 | zero | 2 | 2 | 15 | true |
| utf8dfa | adv | 64 | 8 | warm | 3 | 2 | 17 | true |
| utf8dfa | adv | 64 | 32 | zero | 2 | 2 | 63 | true |
| utf8dfa | adv | 64 | 32 | warm | 3 | 2 | 65 | true |
| csvquote | random | 0.0625 | 8 | zero | 5 | 5 | 16 | true |
| csvquote | random | 0.0625 | 8 | warm | 7 | 6 | 27 | true |
| csvquote | random | 0.0625 | 32 | zero | 32 | 32 | 386 | true |
| csvquote | random | 0.0625 | 32 | warm | 33 | 32 | 440 | true |
| csvquote | text | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| csvquote | text | 0.0625 | 8 | warm | 8 | 7 | 36 | true |
| csvquote | text | 0.0625 | 32 | zero | 32 | 32 | 255 | true |
| csvquote | text | 0.0625 | 32 | warm | 33 | 32 | 299 | true |
| csvquote | adv | 0.0625 | 8 | zero | 8 | 8 | 15 | true |
| csvquote | adv | 0.0625 | 8 | warm | 9 | 8 | 23 | true |
| csvquote | adv | 0.0625 | 32 | zero | 32 | 32 | 63 | true |
| csvquote | adv | 0.0625 | 32 | warm | 33 | 32 | 95 | true |
| csvquote | random | 1 | 8 | zero | 6 | 6 | 16 | true |
| csvquote | random | 1 | 8 | warm | 8 | 7 | 27 | true |
| csvquote | random | 1 | 32 | zero | 32 | 32 | 360 | true |
| csvquote | random | 1 | 32 | warm | 33 | 32 | 412 | true |
| csvquote | text | 1 | 8 | zero | 8 | 8 | 20 | true |
| csvquote | text | 1 | 8 | warm | 9 | 8 | 30 | true |
| csvquote | text | 1 | 32 | zero | 31 | 31 | 247 | true |
| csvquote | text | 1 | 32 | warm | 33 | 32 | 290 | true |
| csvquote | adv | 1 | 8 | zero | 8 | 8 | 15 | true |
| csvquote | adv | 1 | 8 | warm | 9 | 8 | 23 | true |
| csvquote | adv | 1 | 32 | zero | 32 | 32 | 63 | true |
| csvquote | adv | 1 | 32 | warm | 33 | 32 | 95 | true |
| csvquote | random | 64 | 8 | zero | 8 | 8 | 33 | true |
| csvquote | random | 64 | 8 | warm | 8 | 7 | 33 | true |
| csvquote | random | 64 | 32 | zero | 31 | 31 | 388 | true |
| csvquote | random | 64 | 32 | warm | 33 | 32 | 441 | true |
| csvquote | text | 64 | 8 | zero | 8 | 8 | 27 | true |
| csvquote | text | 64 | 8 | warm | 8 | 7 | 24 | true |
| csvquote | text | 64 | 32 | zero | 31 | 31 | 291 | true |
| csvquote | text | 64 | 32 | warm | 33 | 32 | 339 | true |
| csvquote | adv | 64 | 8 | zero | 8 | 8 | 15 | true |
| csvquote | adv | 64 | 8 | warm | 9 | 8 | 23 | true |
| csvquote | adv | 64 | 32 | zero | 32 | 32 | 63 | true |
| csvquote | adv | 64 | 32 | warm | 33 | 32 | 95 | true |
| csvrows | random | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| csvrows | random | 0.0625 | 8 | warm | 9 | 8 | 44 | true |
| csvrows | random | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| csvrows | random | 0.0625 | 32 | warm | 33 | 32 | 511 | true |
| csvrows | text | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| csvrows | text | 0.0625 | 8 | warm | 9 | 8 | 44 | true |
| csvrows | text | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| csvrows | text | 0.0625 | 32 | warm | 33 | 32 | 560 | true |
| csvrows | adv | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| csvrows | adv | 0.0625 | 8 | warm | 9 | 8 | 44 | true |
| csvrows | adv | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| csvrows | adv | 0.0625 | 32 | warm | 33 | 32 | 560 | true |
| csvrows | random | 1 | 8 | zero | 8 | 8 | 36 | true |
| csvrows | random | 1 | 8 | warm | 9 | 8 | 44 | true |
| csvrows | random | 1 | 32 | zero | 32 | 32 | 528 | true |
| csvrows | random | 1 | 32 | warm | 33 | 32 | 560 | true |
| csvrows | text | 1 | 8 | zero | 8 | 8 | 36 | true |
| csvrows | text | 1 | 8 | warm | 9 | 8 | 44 | true |
| csvrows | text | 1 | 32 | zero | 32 | 32 | 528 | true |
| csvrows | text | 1 | 32 | warm | 33 | 32 | 560 | true |
| csvrows | adv | 1 | 8 | zero | 8 | 8 | 36 | true |
| csvrows | adv | 1 | 8 | warm | 9 | 8 | 44 | true |
| csvrows | adv | 1 | 32 | zero | 32 | 32 | 528 | true |
| csvrows | adv | 1 | 32 | warm | 33 | 32 | 560 | true |
| csvrows | random | 64 | 8 | zero | 8 | 8 | 36 | true |
| csvrows | random | 64 | 8 | warm | 9 | 8 | 44 | true |
| csvrows | random | 64 | 32 | zero | 32 | 32 | 528 | true |
| csvrows | random | 64 | 32 | warm | 33 | 32 | 560 | true |
| csvrows | text | 64 | 8 | zero | 8 | 8 | 36 | true |
| csvrows | text | 64 | 8 | warm | 9 | 8 | 44 | true |
| csvrows | text | 64 | 32 | zero | 32 | 32 | 528 | true |
| csvrows | text | 64 | 32 | warm | 33 | 32 | 560 | true |
| csvrows | adv | 64 | 8 | zero | 8 | 8 | 36 | true |
| csvrows | adv | 64 | 8 | warm | 9 | 8 | 44 | true |
| csvrows | adv | 64 | 32 | zero | 32 | 32 | 528 | true |
| csvrows | adv | 64 | 32 | warm | 33 | 32 | 560 | true |
| base64ok | random | 0.0625 | 8 | zero | 7 | 7 | 25 | true |
| base64ok | random | 0.0625 | 8 | warm | 8 | 7 | 30 | true |
| base64ok | random | 0.0625 | 32 | zero | 32 | 32 | 373 | true |
| base64ok | random | 0.0625 | 32 | warm | 33 | 32 | 391 | true |
| base64ok | text | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| base64ok | text | 0.0625 | 8 | warm | 9 | 8 | 36 | true |
| base64ok | text | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| base64ok | text | 0.0625 | 32 | warm | 33 | 32 | 363 | true |
| base64ok | adv | 0.0625 | 8 | zero | 8 | 8 | 15 | true |
| base64ok | adv | 0.0625 | 8 | warm | 9 | 8 | 24 | true |
| base64ok | adv | 0.0625 | 32 | zero | 32 | 32 | 63 | true |
| base64ok | adv | 0.0625 | 32 | warm | 33 | 32 | 96 | true |
| base64ok | random | 1 | 8 | zero | 2 | 2 | 15 | true |
| base64ok | random | 1 | 8 | warm | 2 | 1 | 16 | true |
| base64ok | random | 1 | 32 | zero | 27 | 27 | 159 | true |
| base64ok | random | 1 | 32 | warm | 28 | 27 | 166 | true |
| base64ok | text | 1 | 8 | zero | 8 | 8 | 36 | true |
| base64ok | text | 1 | 8 | warm | 9 | 8 | 41 | true |
| base64ok | text | 1 | 32 | zero | 31 | 31 | 497 | true |
| base64ok | text | 1 | 32 | warm | 33 | 32 | 357 | true |
| base64ok | adv | 1 | 8 | zero | 8 | 8 | 15 | true |
| base64ok | adv | 1 | 8 | warm | 9 | 8 | 24 | true |
| base64ok | adv | 1 | 32 | zero | 32 | 32 | 63 | true |
| base64ok | adv | 1 | 32 | warm | 33 | 32 | 96 | true |
| base64ok | random | 64 | 8 | zero | 5 | 5 | 20 | true |
| base64ok | random | 64 | 8 | warm | 6 | 5 | 23 | true |
| base64ok | random | 64 | 32 | zero | 23 | 23 | 164 | true |
| base64ok | random | 64 | 32 | warm | 24 | 23 | 173 | true |
| base64ok | text | 64 | 8 | zero | 8 | 8 | 36 | true |
| base64ok | text | 64 | 8 | warm | 9 | 8 | 44 | true |
| base64ok | text | 64 | 32 | zero | 32 | 32 | 176 | true |
| base64ok | text | 64 | 32 | warm | 33 | 32 | 329 | true |
| base64ok | adv | 64 | 8 | zero | 8 | 8 | 15 | true |
| base64ok | adv | 64 | 8 | warm | 9 | 8 | 24 | true |
| base64ok | adv | 64 | 32 | zero | 32 | 32 | 63 | true |
| base64ok | adv | 64 | 32 | warm | 33 | 32 | 96 | true |
| rle | random | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| rle | random | 0.0625 | 8 | warm | 9 | 8 | 44 | true |
| rle | random | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| rle | random | 0.0625 | 32 | warm | 33 | 32 | 560 | true |
| rle | text | 0.0625 | 8 | zero | 8 | 8 | 21 | true |
| rle | text | 0.0625 | 8 | warm | 9 | 8 | 29 | true |
| rle | text | 0.0625 | 32 | zero | 32 | 32 | 93 | true |
| rle | text | 0.0625 | 32 | warm | 33 | 32 | 125 | true |
| rle | adv | 0.0625 | 8 | zero | 8 | 8 | 21 | true |
| rle | adv | 0.0625 | 8 | warm | 9 | 8 | 29 | true |
| rle | adv | 0.0625 | 32 | zero | 32 | 32 | 93 | true |
| rle | adv | 0.0625 | 32 | warm | 33 | 32 | 125 | true |
| rle | random | 1 | 8 | zero | 8 | 8 | 36 | true |
| rle | random | 1 | 8 | warm | 9 | 8 | 44 | true |
| rle | random | 1 | 32 | zero | 32 | 32 | 528 | true |
| rle | random | 1 | 32 | warm | 33 | 32 | 560 | true |
| rle | text | 1 | 8 | zero | 8 | 8 | 21 | true |
| rle | text | 1 | 8 | warm | 9 | 8 | 29 | true |
| rle | text | 1 | 32 | zero | 32 | 32 | 93 | true |
| rle | text | 1 | 32 | warm | 33 | 32 | 125 | true |
| rle | adv | 1 | 8 | zero | 8 | 8 | 21 | true |
| rle | adv | 1 | 8 | warm | 9 | 8 | 29 | true |
| rle | adv | 1 | 32 | zero | 32 | 32 | 93 | true |
| rle | adv | 1 | 32 | warm | 33 | 32 | 123 | true |
| rle | random | 64 | 8 | zero | 8 | 8 | 36 | true |
| rle | random | 64 | 8 | warm | 9 | 8 | 44 | true |
| rle | random | 64 | 32 | zero | 32 | 32 | 528 | true |
| rle | random | 64 | 32 | warm | 33 | 32 | 560 | true |
| rle | text | 64 | 8 | zero | 8 | 8 | 21 | true |
| rle | text | 64 | 8 | warm | 9 | 8 | 29 | true |
| rle | text | 64 | 32 | zero | 32 | 32 | 93 | true |
| rle | text | 64 | 32 | warm | 33 | 32 | 125 | true |
| rle | adv | 64 | 8 | zero | 8 | 8 | 21 | true |
| rle | adv | 64 | 8 | warm | 9 | 8 | 28 | true |
| rle | adv | 64 | 32 | zero | 32 | 32 | 93 | true |
| rle | adv | 64 | 32 | warm | 33 | 32 | 121 | true |
| lines | random | 0.0625 | 8 | zero | 2 | 2 | 11 | true |
| lines | random | 0.0625 | 8 | warm | 3 | 2 | 18 | true |
| lines | random | 0.0625 | 32 | zero | 2 | 2 | 46 | true |
| lines | random | 0.0625 | 32 | warm | 3 | 2 | 84 | true |
| lines | text | 0.0625 | 8 | zero | 2 | 2 | 13 | true |
| lines | text | 0.0625 | 8 | warm | 3 | 2 | 20 | true |
| lines | text | 0.0625 | 32 | zero | 2 | 2 | 46 | true |
| lines | text | 0.0625 | 32 | warm | 3 | 2 | 83 | true |
| lines | adv | 0.0625 | 8 | zero | 8 | 8 | 29 | true |
| lines | adv | 0.0625 | 8 | warm | 7 | 6 | 28 | true |
| lines | adv | 0.0625 | 32 | zero | 32 | 32 | 240 | true |
| lines | adv | 0.0625 | 32 | warm | 33 | 32 | 285 | true |
| lines | random | 1 | 8 | zero | 2 | 2 | 11 | true |
| lines | random | 1 | 8 | warm | 3 | 2 | 19 | true |
| lines | random | 1 | 32 | zero | 2 | 2 | 39 | true |
| lines | random | 1 | 32 | warm | 3 | 2 | 74 | true |
| lines | text | 1 | 8 | zero | 2 | 2 | 12 | true |
| lines | text | 1 | 8 | warm | 3 | 2 | 19 | true |
| lines | text | 1 | 32 | zero | 2 | 2 | 53 | true |
| lines | text | 1 | 32 | warm | 3 | 2 | 77 | true |
| lines | adv | 1 | 8 | zero | 8 | 8 | 23 | true |
| lines | adv | 1 | 8 | warm | 9 | 8 | 35 | true |
| lines | adv | 1 | 32 | zero | 32 | 32 | 303 | true |
| lines | adv | 1 | 32 | warm | 32 | 31 | 289 | true |
| lines | random | 64 | 8 | zero | 2 | 2 | 12 | true |
| lines | random | 64 | 8 | warm | 3 | 2 | 20 | true |
| lines | random | 64 | 32 | zero | 2 | 2 | 47 | true |
| lines | random | 64 | 32 | warm | 3 | 2 | 79 | true |
| lines | text | 64 | 8 | zero | 2 | 2 | 12 | true |
| lines | text | 64 | 8 | warm | 3 | 2 | 19 | true |
| lines | text | 64 | 32 | zero | 2 | 2 | 48 | true |
| lines | text | 64 | 32 | warm | 3 | 2 | 80 | true |
| lines | adv | 64 | 8 | zero | 7 | 7 | 20 | true |
| lines | adv | 64 | 8 | warm | 9 | 8 | 32 | true |
| lines | adv | 64 | 32 | zero | 30 | 30 | 270 | true |
| lines | adv | 64 | 32 | warm | 32 | 31 | 316 | true |
| crc32 | random | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| crc32 | random | 0.0625 | 8 | warm | 9 | 8 | 44 | true |
| crc32 | random | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| crc32 | random | 0.0625 | 32 | warm | 33 | 32 | 560 | true |
| crc32 | text | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| crc32 | text | 0.0625 | 8 | warm | 9 | 8 | 44 | true |
| crc32 | text | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| crc32 | text | 0.0625 | 32 | warm | 33 | 32 | 560 | true |
| crc32 | adv | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| crc32 | adv | 0.0625 | 8 | warm | 9 | 8 | 44 | true |
| crc32 | adv | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| crc32 | adv | 0.0625 | 32 | warm | 33 | 32 | 560 | true |
| crc32 | random | 1 | 8 | zero | 8 | 8 | 36 | true |
| crc32 | random | 1 | 8 | warm | 9 | 8 | 44 | true |
| crc32 | random | 1 | 32 | zero | 32 | 32 | 528 | true |
| crc32 | random | 1 | 32 | warm | 33 | 32 | 560 | true |
| crc32 | text | 1 | 8 | zero | 8 | 8 | 36 | true |
| crc32 | text | 1 | 8 | warm | 9 | 8 | 44 | true |
| crc32 | text | 1 | 32 | zero | 32 | 32 | 528 | true |
| crc32 | text | 1 | 32 | warm | 33 | 32 | 560 | true |
| crc32 | adv | 1 | 8 | zero | 8 | 8 | 36 | true |
| crc32 | adv | 1 | 8 | warm | 9 | 8 | 44 | true |
| crc32 | adv | 1 | 32 | zero | 32 | 32 | 528 | true |
| crc32 | adv | 1 | 32 | warm | 33 | 32 | 560 | true |
| crc32 | random | 64 | 8 | zero | 8 | 8 | 36 | true |
| crc32 | random | 64 | 8 | warm | 9 | 8 | 44 | true |
| crc32 | random | 64 | 32 | zero | 32 | 32 | 528 | true |
| crc32 | random | 64 | 32 | warm | 33 | 32 | 560 | true |
| crc32 | text | 64 | 8 | zero | 8 | 8 | 36 | true |
| crc32 | text | 64 | 8 | warm | 9 | 8 | 44 | true |
| crc32 | text | 64 | 32 | zero | 32 | 32 | 528 | true |
| crc32 | text | 64 | 32 | warm | 33 | 32 | 560 | true |
| crc32 | adv | 64 | 8 | zero | 8 | 8 | 36 | true |
| crc32 | adv | 64 | 8 | warm | 9 | 8 | 44 | true |
| crc32 | adv | 64 | 32 | zero | 32 | 32 | 528 | true |
| crc32 | adv | 64 | 32 | warm | 33 | 32 | 560 | true |
| sha256c | random | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| sha256c | random | 0.0625 | 8 | warm | 9 | 8 | 44 | true |
| sha256c | random | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| sha256c | random | 0.0625 | 32 | warm | 33 | 32 | 560 | true |
| sha256c | text | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| sha256c | text | 0.0625 | 8 | warm | 9 | 8 | 44 | true |
| sha256c | text | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| sha256c | text | 0.0625 | 32 | warm | 33 | 32 | 560 | true |
| sha256c | adv | 0.0625 | 8 | zero | 8 | 8 | 36 | true |
| sha256c | adv | 0.0625 | 8 | warm | 8 | 7 | 37 | true |
| sha256c | adv | 0.0625 | 32 | zero | 32 | 32 | 528 | true |
| sha256c | adv | 0.0625 | 32 | warm | 32 | 31 | 529 | true |
| sha256c | random | 1 | 8 | zero | 8 | 8 | 36 | true |
| sha256c | random | 1 | 8 | warm | 9 | 8 | 44 | true |
| sha256c | random | 1 | 32 | zero | 32 | 32 | 528 | true |
| sha256c | random | 1 | 32 | warm | 33 | 32 | 560 | true |
| sha256c | text | 1 | 8 | zero | 8 | 8 | 36 | true |
| sha256c | text | 1 | 8 | warm | 9 | 8 | 44 | true |
| sha256c | text | 1 | 32 | zero | 32 | 32 | 528 | true |
| sha256c | text | 1 | 32 | warm | 33 | 32 | 560 | true |
| sha256c | adv | 1 | 8 | zero | 8 | 8 | 36 | true |
| sha256c | adv | 1 | 8 | warm | 8 | 7 | 37 | true |
| sha256c | adv | 1 | 32 | zero | 32 | 32 | 528 | true |
| sha256c | adv | 1 | 32 | warm | 32 | 31 | 529 | true |
| sha256c | random | 64 | 8 | zero | 8 | 8 | 36 | true |
| sha256c | random | 64 | 8 | warm | 9 | 8 | 44 | true |
| sha256c | random | 64 | 32 | zero | 32 | 32 | 528 | true |
| sha256c | random | 64 | 32 | warm | 33 | 32 | 560 | true |
| sha256c | text | 64 | 8 | zero | 8 | 8 | 36 | true |
| sha256c | text | 64 | 8 | warm | 9 | 8 | 44 | true |
| sha256c | text | 64 | 32 | zero | 32 | 32 | 528 | true |
| sha256c | text | 64 | 32 | warm | 33 | 32 | 560 | true |
| sha256c | adv | 64 | 8 | zero | 8 | 8 | 36 | true |
| sha256c | adv | 64 | 8 | warm | 8 | 7 | 37 | true |
| sha256c | adv | 64 | 32 | zero | 32 | 32 | 528 | true |
| sha256c | adv | 64 | 32 | warm | 32 | 31 | 529 | true |

Every count equals the serial call: true (324 rows)

## Kill condition at K = 8, text-like input (DFA subjects)

| subject | zero guess | warm guess | verdict |
| --- | --- | --- | --- |
| utf8flag | 1 | 2 | survives (zero guess <= 3) |
| utf8dfa | 1 | 2 | survives (zero guess <= 3) |
| csvquote | 8 | 9 | dead for this class |
| csvrows | 8 | 9 | dead for this class |
| base64ok | 8 | 9 | dead for this class |
| rle | 8 | 9 | dead for this class |
| lines | 2 | 3 | survives (zero guess <= 3) |

## Distinct end states over all start states, by segment length

| subject | input | length | starts | distinct end states | encoding |
| --- | --- | --- | --- | --- | --- |
| utf8flag | random | 64 | 512 | 1 | bits 0-7 DFA, bit 8 error flag |
| utf8flag | random | 256 | 512 | 1 | bits 0-7 DFA, bit 8 error flag |
| utf8flag | random | 1024 | 512 | 1 | bits 0-7 DFA, bit 8 error flag |
| utf8flag | text | 64 | 512 | 2 | bits 0-7 DFA, bit 8 error flag |
| utf8flag | text | 256 | 512 | 2 | bits 0-7 DFA, bit 8 error flag |
| utf8flag | text | 1024 | 512 | 2 | bits 0-7 DFA, bit 8 error flag |
| utf8flag | adv | 64 | 512 | 1 | bits 0-7 DFA, bit 8 error flag |
| utf8flag | adv | 256 | 512 | 1 | bits 0-7 DFA, bit 8 error flag |
| utf8flag | adv | 1024 | 512 | 1 | bits 0-7 DFA, bit 8 error flag |
| utf8dfa | random | 64 | 256 | 1 | bits 0-7 DFA |
| utf8dfa | random | 256 | 256 | 1 | bits 0-7 DFA |
| utf8dfa | random | 1024 | 256 | 1 | bits 0-7 DFA |
| utf8dfa | text | 64 | 256 | 1 | bits 0-7 DFA |
| utf8dfa | text | 256 | 256 | 1 | bits 0-7 DFA |
| utf8dfa | text | 1024 | 256 | 1 | bits 0-7 DFA |
| utf8dfa | adv | 64 | 256 | 1 | bits 0-7 DFA |
| utf8dfa | adv | 256 | 256 | 1 | bits 0-7 DFA |
| utf8dfa | adv | 1024 | 256 | 1 | bits 0-7 DFA |
| csvquote | random | 64 | 2 | 2 | in-quote bit |
| csvquote | random | 256 | 2 | 2 | in-quote bit |
| csvquote | random | 1024 | 2 | 2 | in-quote bit |
| csvquote | text | 64 | 2 | 2 | in-quote bit |
| csvquote | text | 256 | 2 | 2 | in-quote bit |
| csvquote | text | 1024 | 2 | 2 | in-quote bit |
| csvquote | adv | 64 | 2 | 2 | in-quote bit |
| csvquote | adv | 256 | 2 | 2 | in-quote bit |
| csvquote | adv | 1024 | 2 | 2 | in-quote bit |
| csvrows | random | 64 | 512 | 512 | in-quote bit and 8 count bits |
| csvrows | random | 256 | 512 | 512 | in-quote bit and 8 count bits |
| csvrows | random | 1024 | 512 | 512 | in-quote bit and 8 count bits |
| csvrows | text | 64 | 512 | 512 | in-quote bit and 8 count bits |
| csvrows | text | 256 | 512 | 512 | in-quote bit and 8 count bits |
| csvrows | text | 1024 | 512 | 512 | in-quote bit and 8 count bits |
| csvrows | adv | 64 | 512 | 512 | in-quote bit and 8 count bits |
| csvrows | adv | 256 | 512 | 512 | in-quote bit and 8 count bits |
| csvrows | adv | 1024 | 512 | 512 | in-quote bit and 8 count bits |
| base64ok | random | 64 | 16 | 8 | phase, owed, rejected |
| base64ok | random | 256 | 16 | 8 | phase, owed, rejected |
| base64ok | random | 1024 | 16 | 8 | phase, owed, rejected |
| base64ok | text | 64 | 16 | 12 | phase, owed, rejected |
| base64ok | text | 256 | 16 | 12 | phase, owed, rejected |
| base64ok | text | 1024 | 16 | 12 | phase, owed, rejected |
| base64ok | adv | 64 | 16 | 12 | phase, owed, rejected |
| base64ok | adv | 256 | 16 | 12 | phase, owed, rejected |
| base64ok | adv | 1024 | 16 | 12 | phase, owed, rejected |
| rle | random | 64 | 262144 | 131074 | phase, count, value, rejected (full encoding) |
| rle | random | 256 | 262144 | 131074 | phase, count, value, rejected (full encoding) |
| rle | random | 1024 | 262144 | 131073 | phase, count, value, rejected (full encoding) |
| rle | text | 64 | 262144 | 131074 | phase, count, value, rejected (full encoding) |
| rle | text | 256 | 262144 | 131074 | phase, count, value, rejected (full encoding) |
| rle | text | 1024 | 262144 | 131074 | phase, count, value, rejected (full encoding) |
| rle | adv | 64 | 262144 | 131074 | phase, count, value, rejected (full encoding) |
| rle | adv | 256 | 262144 | 131074 | phase, count, value, rejected (full encoding) |
| rle | adv | 1024 | 262144 | 131074 | phase, count, value, rejected (full encoding) |
| lines | random | 64 | 2 | 2 | tab parity |
| lines | random | 256 | 2 | 2 | tab parity |
| lines | random | 1024 | 2 | 1 | tab parity |
| lines | text | 64 | 2 | 1 | tab parity |
| lines | text | 256 | 2 | 1 | tab parity |
| lines | text | 1024 | 2 | 1 | tab parity |
| lines | adv | 64 | 2 | 2 | tab parity |
| lines | adv | 256 | 2 | 2 | tab parity |
| lines | adv | 1024 | 2 | 2 | tab parity |

## Wall on TaskPool, 8 workers (af3-wall-all.jsonl, sessions 1,2,3)

| subject | input | MiB | arm | sweeps | chunk runs | wall ms | speedup (range) | cpu ratio | equal |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| utf8flag | random | 0.0625 | serial |  |  | 0.4 | 1.00 | 1.00 | true |
| utf8flag | random | 0.0625 | zero-k8 | 2 | 15 | 0.3 | 1.47 (1.23-1.74) | 2.67 | true |
| utf8flag | random | 0.0625 | warm-k8 | 3 | 20 | 0.4 | 1.11 (1.03-1.16) | 3.13 | true |
| utf8flag | random | 0.0625 | zero-k32 | 2 | 63 | 0.5 | 0.75 (0.60-0.84) | 4.56 | true |
| utf8flag | random | 0.0625 | warm-k32 | 3 | 80 | 0.6 | 0.63 (0.57-0.66) | 6.08 | true |
| utf8flag | text | 0.0625 | serial |  |  | 0.1 | 1.00 | 1.00 | true |
| utf8flag | text | 0.0625 | zero-k8 | 1 | 8 | 0.1 | 1.45 (1.20-1.71) | 2.05 | true |
| utf8flag | text | 0.0625 | warm-k8 | 2 | 16 | 0.2 | 0.77 (0.65-0.89) | 4.11 | true |
| utf8flag | text | 0.0625 | zero-k32 | 8 | 45 | 0.3 | 0.35 (0.34-0.45) | 6.48 | true |
| utf8flag | text | 0.0625 | warm-k32 | 10 | 79 | 0.7 | 0.17 (0.14-0.22) | 19.11 | true |
| utf8flag | adv | 0.0625 | serial |  |  | 0.1 | 1.00 | 1.00 | true |
| utf8flag | adv | 0.0625 | zero-k8 | 2 | 15 | 0.2 | 0.65 (0.52-0.92) | 3.91 | true |
| utf8flag | adv | 0.0625 | warm-k8 | 3 | 17 | 0.3 | 0.42 (0.39-0.68) | 4.29 | true |
| utf8flag | adv | 0.0625 | zero-k32 | 2 | 63 | 0.4 | 0.28 (0.25-0.31) | 10.64 | true |
| utf8flag | adv | 0.0625 | warm-k32 | 3 | 66 | 0.4 | 0.28 (0.28-0.35) | 9.31 | true |
| utf8flag | random | 1 | serial |  |  | 6.8 | 1.00 | 1.00 | true |
| utf8flag | random | 1 | zero-k8 | 2 | 15 | 3.8 | 1.87 (1.69-2.13) | 2.25 | true |
| utf8flag | random | 1 | warm-k8 | 3 | 17 | 5.5 | 1.23 (1.19-1.51) | 2.63 | true |
| utf8flag | random | 1 | zero-k32 | 2 | 63 | 3.8 | 1.80 (1.23-1.93) | 2.34 | true |
| utf8flag | random | 1 | warm-k32 | 3 | 78 | 5.4 | 1.27 (1.04-1.53) | 3.26 | true |
| utf8flag | text | 1 | serial |  |  | 1.9 | 1.00 | 1.00 | true |
| utf8flag | text | 1 | zero-k8 | 1 | 8 | 0.7 | 2.69 (2.19-2.88) | 1.65 | true |
| utf8flag | text | 1 | warm-k8 | 2 | 16 | 1.3 | 1.39 (1.38-1.41) | 2.70 | true |
| utf8flag | text | 1 | zero-k32 | 1 | 32 | 0.7 | 2.66 (2.03-2.73) | 1.42 | true |
| utf8flag | text | 1 | warm-k32 | 2 | 64 | 1.8 | 1.03 (1.01-1.41) | 2.79 | true |
| utf8flag | adv | 1 | serial |  |  | 1.9 | 1.00 | 1.00 | true |
| utf8flag | adv | 1 | zero-k8 | 2 | 15 | 1.7 | 1.07 (1.00-1.16) | 2.74 | true |
| utf8flag | adv | 1 | warm-k8 | 3 | 17 | 2.3 | 0.81 (0.80-0.96) | 2.85 | true |
| utf8flag | adv | 1 | zero-k32 | 2 | 63 | 1.8 | 1.05 (1.00-1.10) | 2.92 | true |
| utf8flag | adv | 1 | warm-k32 | 3 | 66 | 2.0 | 0.92 (0.88-1.01) | 3.06 | true |
| utf8flag | random | 64 | serial |  |  | 433.4 | 1.00 | 1.00 | true |
| utf8flag | random | 64 | zero-k8 | 2 | 15 | 162.0 | 2.68 (2.57-2.80) | 2.09 | true |
| utf8flag | random | 64 | warm-k8 | 3 | 19 | 238.5 | 1.82 (1.72-1.84) | 2.69 | true |
| utf8flag | random | 64 | zero-k32 | 2 | 63 | 164.3 | 2.64 (2.48-2.71) | 2.15 | true |
| utf8flag | random | 64 | warm-k32 | 3 | 74 | 180.5 | 2.41 (2.16-2.57) | 2.51 | true |
| utf8flag | text | 64 | serial |  |  | 129.2 | 1.00 | 1.00 | true |
| utf8flag | text | 64 | zero-k8 | 1 | 8 | 38.7 | 3.40 (3.12-3.53) | 1.28 | true |
| utf8flag | text | 64 | warm-k8 | 2 | 16 | 78.9 | 1.65 (1.63-1.67) | 2.61 | true |
| utf8flag | text | 64 | zero-k32 | 1 | 32 | 32.6 | 3.83 (3.71-4.20) | 1.21 | true |
| utf8flag | text | 64 | warm-k32 | 2 | 64 | 63.2 | 2.04 (1.97-2.13) | 2.53 | true |
| utf8flag | adv | 64 | serial |  |  | 128.2 | 1.00 | 1.00 | true |
| utf8flag | adv | 64 | zero-k8 | 2 | 15 | 76.4 | 1.71 (1.65-1.74) | 2.69 | true |
| utf8flag | adv | 64 | warm-k8 | 3 | 17 | 93.6 | 1.40 (1.35-1.43) | 2.76 | true |
| utf8flag | adv | 64 | zero-k32 | 2 | 63 | 61.6 | 2.09 (2.02-2.12) | 2.32 | true |
| utf8flag | adv | 64 | warm-k32 | 3 | 66 | 74.5 | 1.72 (1.64-1.79) | 2.67 | true |
| utf8dfa | random | 0.0625 | serial |  |  | 0.4 | 1.00 | 1.00 | true |
| utf8dfa | random | 0.0625 | zero-k8 | 2 | 10 | 0.2 | 1.86 (1.80-2.08) | 1.74 | true |
| utf8dfa | random | 0.0625 | warm-k8 | 3 | 20 | 0.4 | 1.09 (1.09-1.23) | 3.31 | true |
| utf8dfa | random | 0.0625 | zero-k32 | 2 | 41 | 0.3 | 1.26 (1.22-1.26) | 2.74 | true |
| utf8dfa | random | 0.0625 | warm-k32 | 3 | 80 | 0.7 | 0.56 (0.52-0.59) | 6.32 | true |
| utf8dfa | text | 0.0625 | serial |  |  | 0.1 | 1.00 | 1.00 | true |
| utf8dfa | text | 0.0625 | zero-k8 | 1 | 8 | 0.1 | 1.40 (1.33-1.74) | 2.04 | true |
| utf8dfa | text | 0.0625 | warm-k8 | 2 | 16 | 0.2 | 0.75 (0.71-0.90) | 4.24 | true |
| utf8dfa | text | 0.0625 | zero-k32 | 2 | 33 | 0.2 | 0.49 (0.44-0.52) | 5.15 | true |
| utf8dfa | text | 0.0625 | warm-k32 | 3 | 66 | 0.5 | 0.25 (0.24-0.34) | 11.05 | true |
| utf8dfa | adv | 0.0625 | serial |  |  | 0.1 | 1.00 | 1.00 | true |
| utf8dfa | adv | 0.0625 | zero-k8 | 2 | 15 | 0.2 | 0.77 (0.59-0.96) | 4.09 | true |
| utf8dfa | adv | 0.0625 | warm-k8 | 3 | 17 | 0.2 | 0.61 (0.48-0.64) | 4.53 | true |
| utf8dfa | adv | 0.0625 | zero-k32 | 2 | 63 | 0.4 | 0.29 (0.29-0.43) | 9.25 | true |
| utf8dfa | adv | 0.0625 | warm-k32 | 3 | 65 | 0.4 | 0.34 (0.28-0.38) | 8.86 | true |
| utf8dfa | random | 1 | serial |  |  | 6.6 | 1.00 | 1.00 | true |
| utf8dfa | random | 1 | zero-k8 | 2 | 9 | 2.6 | 2.50 (2.27-2.57) | 1.62 | true |
| utf8dfa | random | 1 | warm-k8 | 3 | 17 | 4.3 | 1.55 (1.53-1.58) | 2.68 | true |
| utf8dfa | random | 1 | zero-k32 | 2 | 40 | 2.3 | 2.88 (2.83-3.06) | 1.70 | true |
| utf8dfa | random | 1 | warm-k32 | 3 | 78 | 4.2 | 1.58 (1.45-1.60) | 3.06 | true |
| utf8dfa | text | 1 | serial |  |  | 1.9 | 1.00 | 1.00 | true |
| utf8dfa | text | 1 | zero-k8 | 1 | 8 | 0.8 | 2.42 (2.33-2.90) | 1.67 | true |
| utf8dfa | text | 1 | warm-k8 | 2 | 16 | 1.3 | 1.49 (1.28-1.53) | 2.50 | true |
| utf8dfa | text | 1 | zero-k32 | 1 | 32 | 0.7 | 2.86 (2.72-2.91) | 1.32 | true |
| utf8dfa | text | 1 | warm-k32 | 2 | 64 | 1.3 | 1.46 (1.37-1.47) | 2.64 | true |
| utf8dfa | adv | 1 | serial |  |  | 1.9 | 1.00 | 1.00 | true |
| utf8dfa | adv | 1 | zero-k8 | 2 | 15 | 1.2 | 1.64 (1.46-1.64) | 2.67 | true |
| utf8dfa | adv | 1 | warm-k8 | 3 | 17 | 1.5 | 1.30 (1.26-1.31) | 2.46 | true |
| utf8dfa | adv | 1 | zero-k32 | 2 | 63 | 1.3 | 1.43 (1.34-1.60) | 2.42 | true |
| utf8dfa | adv | 1 | warm-k32 | 3 | 65 | 1.4 | 1.38 (1.23-1.41) | 2.48 | true |
| utf8dfa | random | 64 | serial |  |  | 428.3 | 1.00 | 1.00 | true |
| utf8dfa | random | 64 | zero-k8 | 2 | 11 | 158.1 | 2.74 (2.71-2.83) | 1.51 | true |
| utf8dfa | random | 64 | warm-k8 | 3 | 19 | 248.0 | 1.73 (1.66-1.76) | 2.73 | true |
| utf8dfa | random | 64 | zero-k32 | 2 | 38 | 103.9 | 4.12 (3.69-4.87) | 1.28 | true |
| utf8dfa | random | 64 | warm-k32 | 3 | 74 | 195.7 | 2.19 (2.03-2.44) | 2.50 | true |
| utf8dfa | text | 64 | serial |  |  | 128.4 | 1.00 | 1.00 | true |
| utf8dfa | text | 64 | zero-k8 | 1 | 8 | 36.3 | 3.54 (3.54-3.62) | 1.29 | true |
| utf8dfa | text | 64 | warm-k8 | 2 | 16 | 78.0 | 1.67 (1.56-1.73) | 2.72 | true |
| utf8dfa | text | 64 | zero-k32 | 1 | 32 | 33.1 | 3.88 (3.42-4.14) | 1.23 | true |
| utf8dfa | text | 64 | warm-k32 | 2 | 64 | 64.6 | 1.94 (1.84-2.03) | 2.40 | true |
| utf8dfa | adv | 64 | serial |  |  | 123.8 | 1.00 | 1.00 | true |
| utf8dfa | adv | 64 | zero-k8 | 2 | 15 | 70.3 | 1.76 (1.51-1.88) | 2.51 | true |
| utf8dfa | adv | 64 | warm-k8 | 3 | 17 | 95.9 | 1.29 (1.29-1.31) | 2.86 | true |
| utf8dfa | adv | 64 | zero-k32 | 2 | 63 | 64.1 | 1.95 (1.83-2.03) | 2.75 | true |
| utf8dfa | adv | 64 | warm-k32 | 3 | 65 | 68.1 | 1.91 (1.75-1.92) | 2.52 | true |
| csvquote | random | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| csvquote | random | 0.0625 | zero-k8 | 5 | 16 | 0.1 | 0.13 (0.10-0.16) | 13.89 | true |
| csvquote | random | 0.0625 | warm-k8 | 7 | 27 | 0.2 | 0.08 (0.07-0.09) | 24.11 | true |
| csvquote | random | 0.0625 | zero-k32 | 32 | 386 | 2.8 | 0.01 (0.01-0.01) | 398.71 | true |
| csvquote | random | 0.0625 | warm-k32 | 33 | 440 | 2.3 | 0.01 (0.01-0.01) | 415.24 | true |
| csvquote | text | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| csvquote | text | 0.0625 | zero-k8 | 8 | 36 | 0.2 | 0.07 (0.06-0.09) | 28.33 | true |
| csvquote | text | 0.0625 | warm-k8 | 8 | 36 | 0.3 | 0.06 (0.06-0.08) | 34.24 | true |
| csvquote | text | 0.0625 | zero-k32 | 32 | 255 | 1.4 | 0.01 (0.01-0.01) | 183.94 | true |
| csvquote | text | 0.0625 | warm-k32 | 33 | 299 | 1.5 | 0.01 (0.01-0.01) | 259.94 | true |
| csvquote | adv | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| csvquote | adv | 0.0625 | zero-k8 | 8 | 15 | 0.2 | 0.09 (0.09-0.10) | 15.41 | true |
| csvquote | adv | 0.0625 | warm-k8 | 9 | 23 | 0.2 | 0.07 (0.07-0.07) | 23.47 | true |
| csvquote | adv | 0.0625 | zero-k32 | 32 | 63 | 0.6 | 0.03 (0.03-0.03) | 52.94 | true |
| csvquote | adv | 0.0625 | warm-k32 | 33 | 95 | 0.8 | 0.02 (0.02-0.02) | 79.71 | true |
| csvquote | random | 1 | serial |  |  | 0.3 | 1.00 | 1.00 | true |
| csvquote | random | 1 | zero-k8 | 6 | 16 | 0.7 | 0.40 (0.35-0.45) | 3.94 | true |
| csvquote | random | 1 | warm-k8 | 8 | 27 | 1.0 | 0.27 (0.22-0.27) | 6.67 | true |
| csvquote | random | 1 | zero-k32 | 32 | 360 | 5.2 | 0.05 (0.05-0.06) | 35.39 | true |
| csvquote | random | 1 | warm-k32 | 33 | 412 | 5.6 | 0.05 (0.04-0.05) | 43.57 | true |
| csvquote | text | 1 | serial |  |  | 0.3 | 1.00 | 1.00 | true |
| csvquote | text | 1 | zero-k8 | 8 | 20 | 0.8 | 0.32 (0.26-0.34) | 5.07 | true |
| csvquote | text | 1 | warm-k8 | 9 | 30 | 1.1 | 0.25 (0.17-0.25) | 7.64 | true |
| csvquote | text | 1 | zero-k32 | 31 | 247 | 3.9 | 0.07 (0.07-0.09) | 23.32 | true |
| csvquote | text | 1 | warm-k32 | 33 | 290 | 3.9 | 0.07 (0.05-0.07) | 28.80 | true |
| csvquote | adv | 1 | serial |  |  | 0.3 | 1.00 | 1.00 | true |
| csvquote | adv | 1 | zero-k8 | 8 | 15 | 0.7 | 0.38 (0.32-0.38) | 3.92 | true |
| csvquote | adv | 1 | warm-k8 | 9 | 23 | 1.0 | 0.26 (0.23-0.27) | 6.58 | true |
| csvquote | adv | 1 | zero-k32 | 32 | 63 | 1.2 | 0.23 (0.20-0.23) | 6.56 | true |
| csvquote | adv | 1 | warm-k32 | 33 | 95 | 1.5 | 0.17 (0.16-0.18) | 12.63 | true |
| csvquote | random | 64 | serial |  |  | 19.0 | 1.00 | 1.00 | true |
| csvquote | random | 64 | zero-k8 | 8 | 33 | 91.2 | 0.21 (0.21-0.22) | 14.10 | true |
| csvquote | random | 64 | warm-k8 | 8 | 33 | 89.2 | 0.21 (0.20-0.21) | 14.22 | true |
| csvquote | random | 64 | zero-k32 | 31 | 388 | 183.9 | 0.10 (0.10-0.10) | 35.28 | true |
| csvquote | random | 64 | warm-k32 | 33 | 441 | 206.9 | 0.09 (0.09-0.09) | 39.35 | true |
| csvquote | text | 64 | serial |  |  | 19.0 | 1.00 | 1.00 | true |
| csvquote | text | 64 | zero-k8 | 8 | 27 | 78.8 | 0.24 (0.24-0.26) | 11.13 | true |
| csvquote | text | 64 | warm-k8 | 8 | 24 | 70.3 | 0.27 (0.26-0.27) | 9.93 | true |
| csvquote | text | 64 | zero-k32 | 31 | 291 | 138.4 | 0.14 (0.13-0.14) | 25.33 | true |
| csvquote | text | 64 | warm-k32 | 33 | 339 | 169.2 | 0.11 (0.11-0.12) | 30.88 | true |
| csvquote | adv | 64 | serial |  |  | 18.9 | 1.00 | 1.00 | true |
| csvquote | adv | 64 | zero-k8 | 8 | 15 | 51.3 | 0.37 (0.37-0.38) | 5.63 | true |
| csvquote | adv | 64 | warm-k8 | 9 | 23 | 70.0 | 0.27 (0.26-0.27) | 9.21 | true |
| csvquote | adv | 64 | zero-k32 | 32 | 63 | 50.7 | 0.37 (0.37-0.38) | 5.31 | true |
| csvquote | adv | 64 | warm-k32 | 33 | 95 | 62.5 | 0.30 (0.29-0.30) | 8.51 | true |
| csvrows | random | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| csvrows | random | 0.0625 | zero-k8 | 8 | 36 | 0.2 | 0.14 (0.11-0.14) | 18.43 | true |
| csvrows | random | 0.0625 | warm-k8 | 9 | 44 | 0.3 | 0.12 (0.11-0.12) | 22.43 | true |
| csvrows | random | 0.0625 | zero-k32 | 32 | 528 | 3.4 | 0.01 (0.01-0.01) | 289.68 | true |
| csvrows | random | 0.0625 | warm-k32 | 33 | 511 | 3.3 | 0.01 (0.01-0.01) | 291.26 | true |
| csvrows | text | 0.0625 | serial |  |  | 0.1 | 1.00 | 1.00 | true |
| csvrows | text | 0.0625 | zero-k8 | 8 | 36 | 0.3 | 0.22 (0.19-0.23) | 11.85 | true |
| csvrows | text | 0.0625 | warm-k8 | 9 | 44 | 0.3 | 0.22 (0.16-0.25) | 11.60 | true |
| csvrows | text | 0.0625 | zero-k32 | 32 | 528 | 2.1 | 0.03 (0.02-0.03) | 113.30 | true |
| csvrows | text | 0.0625 | warm-k32 | 33 | 560 | 2.5 | 0.02 (0.02-0.03) | 132.28 | true |
| csvrows | adv | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| csvrows | adv | 0.0625 | zero-k8 | 8 | 36 | 0.2 | 0.12 (0.12-0.15) | 19.63 | true |
| csvrows | adv | 0.0625 | warm-k8 | 9 | 44 | 0.3 | 0.10 (0.08-0.12) | 25.33 | true |
| csvrows | adv | 0.0625 | zero-k32 | 32 | 528 | 2.6 | 0.01 (0.01-0.02) | 211.37 | true |
| csvrows | adv | 0.0625 | warm-k32 | 33 | 560 | 2.9 | 0.01 (0.01-0.01) | 245.40 | true |
| csvrows | random | 1 | serial |  |  | 0.5 | 1.00 | 1.00 | true |
| csvrows | random | 1 | zero-k8 | 8 | 36 | 2.0 | 0.24 (0.24-0.35) | 7.86 | true |
| csvrows | random | 1 | warm-k8 | 9 | 44 | 2.4 | 0.20 (0.18-0.34) | 8.49 | true |
| csvrows | random | 1 | zero-k32 | 32 | 528 | 6.5 | 0.07 (0.06-0.11) | 34.42 | true |
| csvrows | random | 1 | warm-k32 | 33 | 560 | 7.3 | 0.07 (0.04-0.11) | 32.74 | true |
| csvrows | text | 1 | serial |  |  | 1.0 | 1.00 | 1.00 | true |
| csvrows | text | 1 | zero-k8 | 8 | 36 | 3.0 | 0.34 (0.29-0.37) | 6.07 | true |
| csvrows | text | 1 | warm-k8 | 9 | 44 | 3.6 | 0.28 (0.28-0.29) | 6.91 | true |
| csvrows | text | 1 | zero-k32 | 32 | 528 | 10.0 | 0.10 (0.09-0.11) | 24.25 | true |
| csvrows | text | 1 | warm-k32 | 33 | 560 | 10.5 | 0.10 (0.08-0.10) | 26.47 | true |
| csvrows | adv | 1 | serial |  |  | 0.5 | 1.00 | 1.00 | true |
| csvrows | adv | 1 | zero-k8 | 8 | 36 | 1.5 | 0.30 (0.26-0.34) | 7.84 | true |
| csvrows | adv | 1 | warm-k8 | 9 | 44 | 1.6 | 0.29 (0.20-0.30) | 9.06 | true |
| csvrows | adv | 1 | zero-k32 | 32 | 528 | 5.0 | 0.09 (0.05-0.09) | 38.65 | true |
| csvrows | adv | 1 | warm-k32 | 33 | 560 | 7.8 | 0.06 (0.05-0.09) | 39.63 | true |
| csvrows | random | 64 | serial |  |  | 33.4 | 1.00 | 1.00 | true |
| csvrows | random | 64 | zero-k8 | 8 | 36 | 119.5 | 0.28 (0.28-0.29) | 11.03 | true |
| csvrows | random | 64 | warm-k8 | 9 | 44 | 145.0 | 0.23 (0.23-0.25) | 12.56 | true |
| csvrows | random | 64 | zero-k32 | 32 | 528 | 284.3 | 0.12 (0.12-0.12) | 33.40 | true |
| csvrows | random | 64 | warm-k32 | 33 | 560 | 307.2 | 0.11 (0.10-0.12) | 35.69 | true |
| csvrows | text | 64 | serial |  |  | 68.3 | 1.00 | 1.00 | true |
| csvrows | text | 64 | zero-k8 | 8 | 36 | 154.5 | 0.44 (0.43-0.45) | 7.47 | true |
| csvrows | text | 64 | warm-k8 | 9 | 44 | 181.5 | 0.38 (0.36-0.39) | 8.89 | true |
| csvrows | text | 64 | zero-k32 | 32 | 528 | 396.2 | 0.17 (0.17-0.18) | 24.72 | true |
| csvrows | text | 64 | warm-k32 | 33 | 560 | 410.2 | 0.17 (0.16-0.17) | 26.19 | true |
| csvrows | adv | 64 | serial |  |  | 32.0 | 1.00 | 1.00 | true |
| csvrows | adv | 64 | zero-k8 | 8 | 36 | 114.9 | 0.28 (0.28-0.30) | 10.59 | true |
| csvrows | adv | 64 | warm-k8 | 9 | 44 | 136.7 | 0.23 (0.21-0.24) | 13.28 | true |
| csvrows | adv | 64 | zero-k32 | 32 | 528 | 276.4 | 0.12 (0.11-0.12) | 34.85 | true |
| csvrows | adv | 64 | warm-k32 | 33 | 560 | 285.6 | 0.11 (0.11-0.11) | 35.39 | true |
| base64ok | random | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| base64ok | random | 0.0625 | zero-k8 | 7 | 25 | 0.2 | 0.12 (0.09-0.13) | 17.60 | true |
| base64ok | random | 0.0625 | warm-k8 | 8 | 30 | 0.2 | 0.09 (0.08-0.09) | 23.33 | true |
| base64ok | random | 0.0625 | zero-k32 | 32 | 373 | 2.1 | 0.01 (0.01-0.01) | 274.81 | true |
| base64ok | random | 0.0625 | warm-k32 | 33 | 391 | 2.3 | 0.01 (0.01-0.01) | 336.67 | true |
| base64ok | text | 0.0625 | serial |  |  | 0.1 | 1.00 | 1.00 | true |
| base64ok | text | 0.0625 | zero-k8 | 8 | 36 | 0.3 | 0.26 (0.25-0.27) | 10.76 | true |
| base64ok | text | 0.0625 | warm-k8 | 9 | 36 | 0.3 | 0.22 (0.21-0.27) | 10.83 | true |
| base64ok | text | 0.0625 | zero-k32 | 32 | 528 | 2.9 | 0.03 (0.02-0.03) | 102.04 | true |
| base64ok | text | 0.0625 | warm-k32 | 33 | 363 | 2.1 | 0.04 (0.03-0.05) | 68.15 | true |
| base64ok | adv | 0.0625 | serial |  |  | 0.1 | 1.00 | 1.00 | true |
| base64ok | adv | 0.0625 | zero-k8 | 8 | 15 | 0.3 | 0.29 (0.29-0.40) | 5.00 | true |
| base64ok | adv | 0.0625 | warm-k8 | 9 | 24 | 0.3 | 0.24 (0.22-0.35) | 7.25 | true |
| base64ok | adv | 0.0625 | zero-k32 | 32 | 63 | 0.7 | 0.11 (0.11-0.16) | 19.76 | true |
| base64ok | adv | 0.0625 | warm-k32 | 33 | 96 | 0.8 | 0.10 (0.08-0.14) | 28.99 | true |
| base64ok | random | 1 | serial |  |  | 0.3 | 1.00 | 1.00 | true |
| base64ok | random | 1 | zero-k8 | 2 | 15 | 0.4 | 0.87 (0.81-0.93) | 3.41 | true |
| base64ok | random | 1 | warm-k8 | 2 | 16 | 0.4 | 0.82 (0.79-0.83) | 3.62 | true |
| base64ok | random | 1 | zero-k32 | 27 | 159 | 1.5 | 0.21 (0.21-0.24) | 12.96 | true |
| base64ok | random | 1 | warm-k32 | 28 | 166 | 1.5 | 0.21 (0.21-0.23) | 13.45 | true |
| base64ok | text | 1 | serial |  |  | 1.4 | 1.00 | 1.00 | true |
| base64ok | text | 1 | zero-k8 | 8 | 36 | 2.6 | 0.52 (0.47-0.55) | 6.42 | true |
| base64ok | text | 1 | warm-k8 | 9 | 41 | 2.7 | 0.51 (0.50-0.54) | 6.41 | true |
| base64ok | text | 1 | zero-k32 | 31 | 497 | 7.7 | 0.18 (0.17-0.19) | 21.48 | true |
| base64ok | text | 1 | warm-k32 | 33 | 357 | 5.5 | 0.25 (0.23-0.26) | 15.24 | true |
| base64ok | adv | 1 | serial |  |  | 1.8 | 1.00 | 1.00 | true |
| base64ok | adv | 1 | zero-k8 | 8 | 15 | 2.9 | 0.62 (0.57-0.67) | 2.85 | true |
| base64ok | adv | 1 | warm-k8 | 9 | 24 | 3.4 | 0.52 (0.47-0.63) | 3.88 | true |
| base64ok | adv | 1 | zero-k32 | 32 | 63 | 3.2 | 0.56 (0.55-0.60) | 2.71 | true |
| base64ok | adv | 1 | warm-k32 | 33 | 96 | 3.6 | 0.50 (0.47-0.54) | 3.85 | true |
| base64ok | random | 64 | serial |  |  | 22.9 | 1.00 | 1.00 | true |
| base64ok | random | 64 | zero-k8 | 5 | 20 | 63.0 | 0.37 (0.36-0.37) | 7.56 | true |
| base64ok | random | 64 | warm-k8 | 6 | 23 | 66.4 | 0.35 (0.33-0.35) | 7.65 | true |
| base64ok | random | 64 | zero-k32 | 23 | 164 | 93.2 | 0.25 (0.25-0.25) | 14.32 | true |
| base64ok | random | 64 | warm-k32 | 24 | 173 | 97.4 | 0.24 (0.23-0.25) | 14.02 | true |
| base64ok | text | 64 | serial |  |  | 91.8 | 1.00 | 1.00 | true |
| base64ok | text | 64 | zero-k8 | 8 | 36 | 173.9 | 0.53 (0.52-0.54) | 6.78 | true |
| base64ok | text | 64 | warm-k8 | 9 | 44 | 202.9 | 0.46 (0.43-0.46) | 8.11 | true |
| base64ok | text | 64 | zero-k32 | 32 | 176 | 200.5 | 0.46 (0.45-0.49) | 7.61 | true |
| base64ok | text | 64 | warm-k32 | 33 | 329 | 318.7 | 0.29 (0.28-0.30) | 14.41 | true |
| base64ok | adv | 64 | serial |  |  | 117.3 | 1.00 | 1.00 | true |
| base64ok | adv | 64 | zero-k8 | 8 | 15 | 157.5 | 0.75 (0.74-0.76) | 2.50 | true |
| base64ok | adv | 64 | warm-k8 | 9 | 24 | 197.4 | 0.59 (0.58-0.60) | 4.23 | true |
| base64ok | adv | 64 | zero-k32 | 32 | 63 | 167.2 | 0.70 (0.70-0.71) | 2.51 | true |
| base64ok | adv | 64 | warm-k32 | 33 | 96 | 197.8 | 0.60 (0.58-0.60) | 3.93 | true |
| rle | random | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| rle | random | 0.0625 | zero-k8 | 8 | 36 | 0.2 | 0.06 (0.06-0.07) | 36.92 | true |
| rle | random | 0.0625 | warm-k8 | 9 | 44 | 0.2 | 0.05 (0.05-0.06) | 45.00 | true |
| rle | random | 0.0625 | zero-k32 | 32 | 528 | 3.2 | 0.00 (0.00-0.00) | 812.36 | true |
| rle | random | 0.0625 | warm-k32 | 33 | 560 | 3.1 | 0.00 (0.00-0.00) | 656.92 | true |
| rle | text | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| rle | text | 0.0625 | zero-k8 | 8 | 21 | 0.2 | 0.12 (0.09-0.13) | 17.23 | true |
| rle | text | 0.0625 | warm-k8 | 9 | 29 | 0.2 | 0.10 (0.06-0.11) | 20.30 | true |
| rle | text | 0.0625 | zero-k32 | 32 | 93 | 0.6 | 0.03 (0.02-0.04) | 52.10 | true |
| rle | text | 0.0625 | warm-k32 | 33 | 125 | 0.8 | 0.02 (0.02-0.03) | 73.30 | true |
| rle | adv | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| rle | adv | 0.0625 | zero-k8 | 8 | 21 | 0.2 | 0.10 (0.10-0.12) | 16.62 | true |
| rle | adv | 0.0625 | warm-k8 | 9 | 29 | 0.3 | 0.08 (0.08-0.09) | 23.38 | true |
| rle | adv | 0.0625 | zero-k32 | 32 | 93 | 0.7 | 0.03 (0.03-0.04) | 58.05 | true |
| rle | adv | 0.0625 | warm-k32 | 33 | 125 | 0.9 | 0.02 (0.02-0.03) | 80.00 | true |
| rle | random | 1 | serial |  |  | 0.2 | 1.00 | 1.00 | true |
| rle | random | 1 | zero-k8 | 8 | 36 | 1.0 | 0.19 (0.17-0.20) | 10.18 | true |
| rle | random | 1 | warm-k8 | 9 | 44 | 1.3 | 0.15 (0.14-0.17) | 12.91 | true |
| rle | random | 1 | zero-k32 | 32 | 528 | 6.6 | 0.03 (0.02-0.03) | 93.72 | true |
| rle | random | 1 | warm-k32 | 33 | 560 | 5.5 | 0.04 (0.03-0.04) | 69.96 | true |
| rle | text | 1 | serial |  |  | 0.3 | 1.00 | 1.00 | true |
| rle | text | 1 | zero-k8 | 8 | 21 | 1.1 | 0.31 (0.28-0.38) | 5.14 | true |
| rle | text | 1 | warm-k8 | 9 | 29 | 1.5 | 0.23 (0.23-0.28) | 7.08 | true |
| rle | text | 1 | zero-k32 | 32 | 93 | 1.8 | 0.19 (0.18-0.25) | 8.13 | true |
| rle | text | 1 | warm-k32 | 33 | 125 | 2.1 | 0.17 (0.14-0.21) | 11.52 | true |
| rle | adv | 1 | serial |  |  | 0.3 | 1.00 | 1.00 | true |
| rle | adv | 1 | zero-k8 | 8 | 21 | 1.2 | 0.28 (0.27-0.35) | 4.78 | true |
| rle | adv | 1 | warm-k8 | 9 | 29 | 1.5 | 0.24 (0.21-0.28) | 6.55 | true |
| rle | adv | 1 | zero-k32 | 32 | 93 | 1.7 | 0.20 (0.19-0.25) | 7.35 | true |
| rle | adv | 1 | warm-k32 | 33 | 123 | 2.2 | 0.17 (0.14-0.19) | 9.66 | true |
| rle | random | 64 | serial |  |  | 13.9 | 1.00 | 1.00 | true |
| rle | random | 64 | zero-k8 | 8 | 36 | 93.5 | 0.14 (0.14-0.16) | 18.21 | true |
| rle | random | 64 | warm-k8 | 9 | 44 | 113.8 | 0.12 (0.12-0.13) | 21.42 | true |
| rle | random | 64 | zero-k32 | 32 | 528 | 241.7 | 0.06 (0.05-0.06) | 60.72 | true |
| rle | random | 64 | warm-k32 | 33 | 560 | 260.8 | 0.05 (0.05-0.06) | 67.61 | true |
| rle | text | 64 | serial |  |  | 23.8 | 1.00 | 1.00 | true |
| rle | text | 64 | zero-k8 | 8 | 21 | 74.0 | 0.32 (0.30-0.36) | 7.18 | true |
| rle | text | 64 | warm-k8 | 9 | 29 | 99.9 | 0.25 (0.24-0.26) | 10.24 | true |
| rle | text | 64 | zero-k32 | 32 | 93 | 77.4 | 0.30 (0.30-0.35) | 7.26 | true |
| rle | text | 64 | warm-k32 | 33 | 125 | 93.8 | 0.25 (0.25-0.28) | 10.22 | true |
| rle | adv | 64 | serial |  |  | 26.5 | 1.00 | 1.00 | true |
| rle | adv | 64 | zero-k8 | 8 | 21 | 74.1 | 0.36 (0.33-0.36) | 6.62 | true |
| rle | adv | 64 | warm-k8 | 9 | 28 | 97.0 | 0.27 (0.26-0.30) | 9.79 | true |
| rle | adv | 64 | zero-k32 | 32 | 93 | 76.7 | 0.35 (0.30-0.36) | 6.59 | true |
| rle | adv | 64 | warm-k32 | 33 | 121 | 90.5 | 0.29 (0.26-0.30) | 9.03 | true |
| lines | random | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| lines | random | 0.0625 | zero-k8 | 2 | 11 | 0.1 | 0.25 (0.17-0.30) | 9.08 | true |
| lines | random | 0.0625 | warm-k8 | 3 | 18 | 0.2 | 0.15 (0.11-0.20) | 13.74 | true |
| lines | random | 0.0625 | zero-k32 | 2 | 46 | 0.3 | 0.09 (0.07-0.11) | 26.88 | true |
| lines | random | 0.0625 | warm-k32 | 3 | 84 | 0.5 | 0.05 (0.03-0.06) | 50.13 | true |
| lines | text | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| lines | text | 0.0625 | zero-k8 | 2 | 13 | 0.1 | 0.27 (0.21-0.29) | 6.81 | true |
| lines | text | 0.0625 | warm-k8 | 3 | 20 | 0.2 | 0.20 (0.13-0.24) | 10.49 | true |
| lines | text | 0.0625 | zero-k32 | 2 | 46 | 0.3 | 0.10 (0.10-0.16) | 17.03 | true |
| lines | text | 0.0625 | warm-k32 | 3 | 83 | 0.4 | 0.09 (0.06-0.10) | 25.65 | true |
| lines | adv | 0.0625 | serial |  |  | 0.0 | 1.00 | 1.00 | true |
| lines | adv | 0.0625 | zero-k8 | 8 | 29 | 0.2 | 0.16 (0.09-0.16) | 14.94 | true |
| lines | adv | 0.0625 | warm-k8 | 7 | 28 | 0.2 | 0.17 (0.10-0.17) | 13.58 | true |
| lines | adv | 0.0625 | zero-k32 | 32 | 240 | 1.3 | 0.02 (0.02-0.03) | 107.69 | true |
| lines | adv | 0.0625 | warm-k32 | 33 | 285 | 4.5 | 0.01 (0.00-0.01) | 390.97 | true |
| lines | random | 1 | serial |  |  | 0.4 | 1.00 | 1.00 | true |
| lines | random | 1 | zero-k8 | 2 | 11 | 0.3 | 1.07 (0.76-1.23) | 2.60 | true |
| lines | random | 1 | warm-k8 | 3 | 19 | 0.7 | 0.52 (0.43-0.63) | 4.46 | true |
| lines | random | 1 | zero-k32 | 2 | 39 | 0.5 | 0.76 (0.73-0.97) | 3.03 | true |
| lines | random | 1 | warm-k32 | 3 | 74 | 0.8 | 0.43 (0.42-0.50) | 5.79 | true |
| lines | text | 1 | serial |  |  | 0.6 | 1.00 | 1.00 | true |
| lines | text | 1 | zero-k8 | 2 | 12 | 0.5 | 1.22 (1.09-1.23) | 2.34 | true |
| lines | text | 1 | warm-k8 | 3 | 19 | 0.9 | 0.66 (0.58-0.68) | 4.01 | true |
| lines | text | 1 | zero-k32 | 2 | 53 | 0.6 | 0.90 (0.87-0.94) | 3.89 | true |
| lines | text | 1 | warm-k32 | 3 | 77 | 0.8 | 0.68 (0.62-0.72) | 4.58 | true |
| lines | adv | 1 | serial |  |  | 0.5 | 1.00 | 1.00 | true |
| lines | adv | 1 | zero-k8 | 8 | 23 | 1.1 | 0.44 (0.44-0.48) | 4.65 | true |
| lines | adv | 1 | warm-k8 | 9 | 35 | 1.4 | 0.35 (0.35-0.37) | 7.11 | true |
| lines | adv | 1 | zero-k32 | 32 | 303 | 3.6 | 0.13 (0.11-0.14) | 21.66 | true |
| lines | adv | 1 | warm-k32 | 32 | 289 | 3.6 | 0.14 (0.11-0.16) | 20.67 | true |
| lines | random | 64 | serial |  |  | 25.7 | 1.00 | 1.00 | true |
| lines | random | 64 | zero-k8 | 2 | 12 | 34.4 | 0.78 (0.69-0.79) | 4.68 | true |
| lines | random | 64 | warm-k8 | 3 | 20 | 55.2 | 0.48 (0.47-0.50) | 6.55 | true |
| lines | random | 64 | zero-k32 | 2 | 47 | 23.6 | 1.13 (1.06-1.23) | 3.23 | true |
| lines | random | 64 | warm-k32 | 3 | 79 | 40.2 | 0.66 (0.58-0.67) | 6.03 | true |
| lines | text | 64 | serial |  |  | 39.3 | 1.00 | 1.00 | true |
| lines | text | 64 | zero-k8 | 2 | 12 | 36.5 | 1.08 (0.99-1.15) | 3.59 | true |
| lines | text | 64 | warm-k8 | 3 | 19 | 57.4 | 0.69 (0.65-0.69) | 5.15 | true |
| lines | text | 64 | zero-k32 | 2 | 48 | 25.9 | 1.52 (1.32-1.54) | 2.71 | true |
| lines | text | 64 | warm-k32 | 3 | 80 | 44.4 | 0.89 (0.80-0.92) | 4.58 | true |
| lines | adv | 64 | serial |  |  | 34.5 | 1.00 | 1.00 | true |
| lines | adv | 64 | zero-k8 | 7 | 20 | 71.9 | 0.48 (0.46-0.49) | 5.79 | true |
| lines | adv | 64 | warm-k8 | 9 | 32 | 107.5 | 0.31 (0.31-0.33) | 8.23 | true |
| lines | adv | 64 | zero-k32 | 30 | 270 | 157.0 | 0.22 (0.21-0.22) | 17.30 | true |
| lines | adv | 64 | warm-k32 | 32 | 316 | 181.4 | 0.19 (0.19-0.19) | 20.75 | true |
| crc32 | random | 0.0625 | serial |  |  | 0.1 | 1.00 | 1.00 | true |
| crc32 | random | 0.0625 | zero-k8 | 8 | 36 | 0.4 | 0.27 (0.27-0.32) | 9.21 | true |
| crc32 | random | 0.0625 | warm-k8 | 9 | 44 | 0.5 | 0.23 (0.21-0.24) | 11.58 | true |
| crc32 | random | 0.0625 | zero-k32 | 32 | 528 | 4.1 | 0.03 (0.03-0.03) | 98.13 | true |
| crc32 | random | 0.0625 | warm-k32 | 33 | 560 | 3.9 | 0.03 (0.03-0.03) | 83.63 | true |
| crc32 | text | 0.0625 | serial |  |  | 0.1 | 1.00 | 1.00 | true |
| crc32 | text | 0.0625 | zero-k8 | 8 | 36 | 0.3 | 0.35 (0.19-0.36) | 8.32 | true |
| crc32 | text | 0.0625 | warm-k8 | 9 | 44 | 0.5 | 0.25 (0.17-0.30) | 10.29 | true |
| crc32 | text | 0.0625 | zero-k32 | 32 | 528 | 3.1 | 0.04 (0.03-0.04) | 74.09 | true |
| crc32 | text | 0.0625 | warm-k32 | 33 | 560 | 3.5 | 0.03 (0.03-0.04) | 73.61 | true |
| crc32 | adv | 0.0625 | serial |  |  | 0.1 | 1.00 | 1.00 | true |
| crc32 | adv | 0.0625 | zero-k8 | 8 | 36 | 0.5 | 0.22 (0.20-0.36) | 7.89 | true |
| crc32 | adv | 0.0625 | warm-k8 | 9 | 44 | 0.7 | 0.17 (0.16-0.25) | 9.53 | true |
| crc32 | adv | 0.0625 | zero-k32 | 32 | 528 | 3.5 | 0.03 (0.03-0.04) | 57.36 | true |
| crc32 | adv | 0.0625 | warm-k32 | 33 | 560 | 3.8 | 0.03 (0.03-0.04) | 70.08 | true |
| crc32 | random | 1 | serial |  |  | 1.9 | 1.00 | 1.00 | true |
| crc32 | random | 1 | zero-k8 | 8 | 36 | 2.9 | 0.64 (0.49-0.80) | 5.51 | true |
| crc32 | random | 1 | warm-k8 | 9 | 44 | 3.5 | 0.53 (0.30-0.70) | 6.49 | true |
| crc32 | random | 1 | zero-k32 | 32 | 528 | 10.9 | 0.17 (0.11-0.22) | 21.90 | true |
| crc32 | random | 1 | warm-k32 | 33 | 560 | 11.6 | 0.16 (0.09-0.25) | 22.35 | true |
| crc32 | text | 1 | serial |  |  | 1.9 | 1.00 | 1.00 | true |
| crc32 | text | 1 | zero-k8 | 8 | 36 | 4.9 | 0.37 (0.31-0.70) | 5.50 | true |
| crc32 | text | 1 | warm-k8 | 9 | 44 | 4.7 | 0.40 (0.30-0.57) | 6.48 | true |
| crc32 | text | 1 | zero-k32 | 32 | 528 | 9.9 | 0.19 (0.08-0.19) | 21.36 | true |
| crc32 | text | 1 | warm-k32 | 33 | 560 | 14.0 | 0.13 (0.10-0.18) | 24.08 | true |
| crc32 | adv | 1 | serial |  |  | 1.9 | 1.00 | 1.00 | true |
| crc32 | adv | 1 | zero-k8 | 8 | 36 | 5.5 | 0.34 (0.34-0.45) | 5.73 | true |
| crc32 | adv | 1 | warm-k8 | 9 | 44 | 5.7 | 0.33 (0.30-0.37) | 6.57 | true |
| crc32 | adv | 1 | zero-k32 | 32 | 528 | 17.2 | 0.11 (0.09-0.17) | 22.18 | true |
| crc32 | adv | 1 | warm-k32 | 33 | 560 | 16.5 | 0.11 (0.09-0.16) | 22.02 | true |
| crc32 | random | 64 | serial |  |  | 119.4 | 1.00 | 1.00 | true |
| crc32 | random | 64 | zero-k8 | 8 | 36 | 213.3 | 0.56 (0.55-0.57) | 6.38 | true |
| crc32 | random | 64 | warm-k8 | 9 | 44 | 252.2 | 0.47 (0.46-0.48) | 7.56 | true |
| crc32 | random | 64 | zero-k32 | 32 | 528 | 594.3 | 0.20 (0.20-0.21) | 21.44 | true |
| crc32 | random | 64 | warm-k32 | 33 | 560 | 596.1 | 0.20 (0.19-0.20) | 22.79 | true |
| crc32 | text | 64 | serial |  |  | 119.8 | 1.00 | 1.00 | true |
| crc32 | text | 64 | zero-k8 | 8 | 36 | 216.3 | 0.55 (0.54-0.58) | 6.10 | true |
| crc32 | text | 64 | warm-k8 | 9 | 44 | 255.1 | 0.47 (0.47-0.50) | 7.51 | true |
| crc32 | text | 64 | zero-k32 | 32 | 528 | 547.6 | 0.22 (0.21-0.22) | 21.10 | true |
| crc32 | text | 64 | warm-k32 | 33 | 560 | 597.0 | 0.20 (0.20-0.21) | 22.38 | true |
| crc32 | adv | 64 | serial |  |  | 117.6 | 1.00 | 1.00 | true |
| crc32 | adv | 64 | zero-k8 | 8 | 36 | 216.9 | 0.54 (0.54-0.56) | 6.18 | true |
| crc32 | adv | 64 | warm-k8 | 9 | 44 | 238.0 | 0.49 (0.45-0.49) | 7.56 | true |
| crc32 | adv | 64 | zero-k32 | 32 | 528 | 533.7 | 0.22 (0.22-0.22) | 21.40 | true |
| crc32 | adv | 64 | warm-k32 | 33 | 560 | 554.1 | 0.21 (0.21-0.22) | 22.71 | true |
| sha256c | random | 0.0625 | serial |  |  | 0.2 | 1.00 | 1.00 | true |
| sha256c | random | 0.0625 | zero-k8 | 8 | 36 | 0.5 | 0.36 (0.35-0.41) | 7.91 | true |
| sha256c | random | 0.0625 | warm-k8 | 9 | 44 | 0.5 | 0.30 (0.26-0.34) | 9.29 | true |
| sha256c | random | 0.0625 | zero-k32 | 32 | 528 | 4.2 | 0.04 (0.03-0.05) | 70.91 | true |
| sha256c | random | 0.0625 | warm-k32 | 33 | 560 | 4.0 | 0.04 (0.04-0.04) | 66.82 | true |
| sha256c | text | 0.0625 | serial |  |  | 0.2 | 1.00 | 1.00 | true |
| sha256c | text | 0.0625 | zero-k8 | 8 | 36 | 0.4 | 0.38 (0.20-0.39) | 7.32 | true |
| sha256c | text | 0.0625 | warm-k8 | 9 | 44 | 0.5 | 0.33 (0.18-0.37) | 8.93 | true |
| sha256c | text | 0.0625 | zero-k32 | 32 | 528 | 3.6 | 0.05 (0.04-0.05) | 58.56 | true |
| sha256c | text | 0.0625 | warm-k32 | 33 | 560 | 3.4 | 0.05 (0.04-0.05) | 63.00 | true |
| sha256c | adv | 0.0625 | serial |  |  | 0.2 | 1.00 | 1.00 | true |
| sha256c | adv | 0.0625 | zero-k8 | 8 | 36 | 0.5 | 0.30 (0.18-0.30) | 7.38 | true |
| sha256c | adv | 0.0625 | warm-k8 | 8 | 37 | 0.7 | 0.24 (0.22-0.25) | 7.63 | true |
| sha256c | adv | 0.0625 | zero-k32 | 32 | 528 | 4.3 | 0.04 (0.03-0.06) | 54.66 | true |
| sha256c | adv | 0.0625 | warm-k32 | 32 | 529 | 4.4 | 0.04 (0.03-0.04) | 58.18 | true |
| sha256c | random | 1 | serial |  |  | 2.6 | 1.00 | 1.00 | true |
| sha256c | random | 1 | zero-k8 | 8 | 36 | 5.8 | 0.45 (0.44-0.50) | 5.56 | true |
| sha256c | random | 1 | warm-k8 | 9 | 44 | 6.6 | 0.40 (0.37-0.40) | 6.42 | true |
| sha256c | random | 1 | zero-k32 | 32 | 528 | 20.0 | 0.13 (0.13-0.17) | 20.92 | true |
| sha256c | random | 1 | warm-k32 | 33 | 560 | 19.2 | 0.14 (0.12-0.15) | 22.25 | true |
| sha256c | text | 1 | serial |  |  | 2.6 | 1.00 | 1.00 | true |
| sha256c | text | 1 | zero-k8 | 8 | 36 | 5.2 | 0.50 (0.49-0.60) | 5.53 | true |
| sha256c | text | 1 | warm-k8 | 9 | 44 | 6.1 | 0.43 (0.38-0.51) | 6.24 | true |
| sha256c | text | 1 | zero-k32 | 32 | 528 | 16.3 | 0.16 (0.14-0.19) | 20.77 | true |
| sha256c | text | 1 | warm-k32 | 33 | 560 | 16.8 | 0.15 (0.15-0.16) | 23.26 | true |
| sha256c | adv | 1 | serial |  |  | 2.6 | 1.00 | 1.00 | true |
| sha256c | adv | 1 | zero-k8 | 8 | 36 | 4.5 | 0.57 (0.57-0.58) | 5.55 | true |
| sha256c | adv | 1 | warm-k8 | 8 | 37 | 4.6 | 0.56 (0.56-0.59) | 5.28 | true |
| sha256c | adv | 1 | zero-k32 | 32 | 528 | 13.3 | 0.20 (0.17-0.20) | 20.19 | true |
| sha256c | adv | 1 | warm-k32 | 32 | 529 | 14.1 | 0.18 (0.17-0.19) | 21.08 | true |
| sha256c | random | 64 | serial |  |  | 168.0 | 1.00 | 1.00 | true |
| sha256c | random | 64 | zero-k8 | 8 | 36 | 278.0 | 0.60 (0.60-0.63) | 5.80 | true |
| sha256c | random | 64 | warm-k8 | 9 | 44 | 308.0 | 0.54 (0.53-0.55) | 6.84 | true |
| sha256c | random | 64 | zero-k32 | 32 | 528 | 723.2 | 0.23 (0.21-0.24) | 19.87 | true |
| sha256c | random | 64 | warm-k32 | 33 | 560 | 810.4 | 0.21 (0.21-0.22) | 21.15 | true |
| sha256c | text | 64 | serial |  |  | 168.6 | 1.00 | 1.00 | true |
| sha256c | text | 64 | zero-k8 | 8 | 36 | 265.1 | 0.64 (0.63-0.66) | 5.60 | true |
| sha256c | text | 64 | warm-k8 | 9 | 44 | 307.4 | 0.55 (0.54-0.56) | 6.92 | true |
| sha256c | text | 64 | zero-k32 | 32 | 528 | 724.5 | 0.23 (0.23-0.25) | 19.91 | true |
| sha256c | text | 64 | warm-k32 | 33 | 560 | 754.9 | 0.22 (0.22-0.24) | 21.17 | true |
| sha256c | adv | 64 | serial |  |  | 167.0 | 1.00 | 1.00 | true |
| sha256c | adv | 64 | zero-k8 | 8 | 36 | 261.8 | 0.64 (0.63-0.64) | 5.72 | true |
| sha256c | adv | 64 | warm-k8 | 8 | 37 | 278.2 | 0.60 (0.60-0.63) | 5.80 | true |
| sha256c | adv | 64 | zero-k32 | 32 | 528 | 717.4 | 0.23 (0.23-0.24) | 20.03 | true |
| sha256c | adv | 64 | warm-k32 | 32 | 529 | 711.1 | 0.23 (0.23-0.25) | 20.05 | true |
