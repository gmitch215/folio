| driver | serial ms | us per record | automatic | forced | explicit | in place | route can win | auto admitted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| aes-cbc-decrypt | 17.7 | 138.5 | 0.92 | 0.89 | 3.50 | 3.88 | no | yes |
| aes-cbc-decrypt-shared | 17.6 | 137.4 | 0.79 | 0.34 | 3.47 | - | no | yes |
| aes-cbc-encrypt | 8.2 | 64.3 | 0.90 | 0.69 | 2.84 | 3.24 | no | yes |
| aes-cbc-encrypt-slot | 8.2 | 64.2 | 1.00 | 0.98 | 3.64 | 3.53 | no | yes |
| aes-ctr | 9.3 | 72.7 | 1.03 | 1.03 | 3.54 | 3.48 | yes | yes |
| jsmn-parse | 1.2 | 9.2 | 0.96 | 0.30 | 2.16 | 2.99 | no | no |
| jsmn-parse-shared | 1.5 | 11.9 | 0.94 | 0.13 | 2.04 | - | no | no |
| jsmn-parse-slot | 1.2 | 9.2 | 0.93 | 0.33 | 1.94 | 2.92 | no | no |
| kissfft-complex | 3.2 | 25.3 | 0.74 | 0.41 | 1.54 | 2.81 | no | yes |
| kissfft-real | 2.1 | 16.5 | 0.82 | 0.35 | 2.12 | 3.31 | no | no |
| kissfft-real-shared | 1.9 | 15.2 | 0.96 | 0.12 | 1.93 | - | no | no |
| lz4-compress | 6.8 | 53.2 | 1.05 | 1.18 | 2.31 | 3.30 | yes | yes |
| lz4-decompress | 0.9 | 6.7 | 0.91 | 0.15 | 0.68 | 2.24 | no | no |
| m6502 | 3.4 | 52.9 | 0.44 | 0.17 | 2.24 | 3.31 | no | yes |
| md5 | 6.6 | 51.2 | 1.54 | 1.95 | 3.07 | 3.75 | yes | yes |
| md5-slot | 6.5 | 50.4 | 1.51 | 1.73 | 2.77 | 3.47 | yes | yes |
| miniz-adler32 | 3.3 | 25.6 | 0.86 | 0.57 | 1.05 | 2.58 | no | yes |
| miniz-compress | 9.7 | 150.9 | 0.99 | 0.98 | 2.97 | - | no | no |
| miniz-crc32 | 7.3 | 56.9 | 1.75 | 2.76 | 2.93 | 3.34 | yes | yes |
| miniz-decompress | 3.2 | 50.7 | 0.67 | 0.64 | 2.36 | 3.01 | no | yes |
| qoi-decode | 3.7 | 28.9 | 1.00 | 1.00 | 1.61 | 2.53 | no | no |
| qoi-decode-64 | 1.7 | 12.9 | 0.96 | 0.23 | 1.91 | 3.06 | no | no |
| qoi-encode | 4.5 | 35.3 | 0.78 | 0.42 | 1.48 | - | no | yes |
| qoi-encode-64 | 2.0 | 15.7 | 0.97 | 0.33 | 1.57 | 3.26 | no | no |
| sha1 | 9.6 | 75.4 | 1.38 | 1.75 | 3.33 | 3.56 | yes | yes |
| sha256 | 13.1 | 102.6 | 1.79 | 1.93 | 3.33 | 3.43 | yes | yes |
| sha256-shared | 13.0 | 101.6 | 0.94 | 0.80 | 3.18 | - | no | yes |
| xxhash3 | 0.9 | 7.4 | 0.91 | 0.39 | 0.39 | 2.69 | no | no |
| xxhash32 | 1.2 | 9.4 | 0.91 | 0.55 | 0.48 | 2.13 | no | no |
| xxhash64 | 0.6 | 5.0 | 0.83 | 0.39 | 0.29 | 1.94 | no | no |

Admission against the label (a tracked route beats serial in at least two thirds of sessions):

| | route can win | route cannot win |
| --- | ---: | ---: |
| automatic admits | 7 | 10 |
| automatic refuses | 0 | 13 |

Regret against the best measured tracked mode (extra time as a fraction of the oracle time):

| policy | loops | mean | 90th percentile | max | weighted by serial time |
| --- | ---: | ---: | ---: | ---: | ---: |
| automatic | 30 | 0.186 | 0.353 | 1.274 | 0.162 |
| forced | 30 | 1.558 | 4.812 | 7.072 | 0.852 |
| serial | 30 | 0.178 | 0.747 | 1.763 | 0.151 |

Fixed-cost planner (admit when serial work >= 5 ms and cost per record >= 0 us, fitted on 20 loops, tested on 10):

| policy | loops | mean | 90th percentile | max | weighted by serial time |
| --- | ---: | ---: | ---: | ---: | ---: |
| planner, train | 20 | 0.104 | 0.018 | 1.942 | 0.376 |
| planner, test | 10 | 0.070 | 0.244 | 0.441 | 0.137 |
| automatic, train | 20 | 0.218 | 0.494 | 1.274 | 0.196 |
| automatic, test | 10 | 0.122 | 0.264 | 0.353 | 0.097 |

The planner admits 13 of 30 loops and 7 of the 7 that can win; automatic admits 17 and 7.
Test split: loops at sorted positions 3, 6, 9 and so on (aes-cbc-encrypt, jsmn-parse, kissfft-complex, lz4-compress, md5, miniz-compress, qoi-decode, qoi-encode-64, sha256-shared, xxhash64).

Geometric mean speedup over all loops (a mode that failed its output check or does not apply counts as serial, 1.00):

| mode | geometric mean | loops above 1.0 |
| --- | ---: | ---: |
| automatic | 0.97 | 7 |
| forced | 0.56 | 7 |
| explicit private contexts | 1.89 | 26 |
| in place, caller declares independence | 2.43 | 24 |
| best exact mode per loop | 2.90 | 30 |

The 10 loops automatic admitted where no tracked route wins, speedup mean and worst:

| route | speedup |
| --- | --- |
| automatic, with the first batch and the bound stop | 0.80 (worst 0.44) |
| forced, dispatching without them | 0.59 (worst 0.17) |

A serial-work gate in front of the protected route (serial work >= 4 ms and cost per record >= 50 us, fitted on the same 20 loops):

| policy | loops | mean | 90th percentile | max | weighted by serial time |
| --- | ---: | ---: | ---: | ---: | ---: |
| gate then protected, train | 20 | 0.071 | 0.263 | 0.581 | 0.105 |
| gate then protected, test | 10 | 0.059 | 0.132 | 0.264 | 0.070 |
| automatic, train | 20 | 0.218 | 0.494 | 1.274 | 0.196 |
| automatic, test | 10 | 0.122 | 0.264 | 0.353 | 0.097 |
