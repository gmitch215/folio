| driver | serial ms | us per record | automatic | forced | explicit | in place | route can win | auto admitted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| blake2b | 10.8 | 42.4 | 1.84 | 2.19 | 2.11 | 3.46 | yes | yes |
| brotli-compress | 58.7 | 1222.5 | 1.00 | - | 3.94 | - | no | no |
| brotli-decompress | 7.9 | 122.7 | 0.99 | 1.00 | 2.85 | - | no | no |
| md4c-html | 11.6 | 724.4 | 1.00 | 0.99 | 3.27 | - | no | no |
| qoa-decode | 0.9 | 28.6 | 0.98 | 0.98 | 2.17 | - | no | no |
| qoa-encode | 10.8 | 337.1 | 1.00 | 0.99 | 3.96 | - | no | no |
| wyhash | 2.8 | 0.7 | 0.82 | 0.13 | 1.94 | 3.12 | no | yes |
| yyjson-read | 3.9 | 3.8 | 0.80 | 0.10 | 1.96 | - | no | yes |

Admission against the label (a tracked route beats serial in at least two thirds of sessions):

| | route can win | route cannot win |
| --- | ---: | ---: |
| automatic admits | 1 | 2 |
| automatic refuses | 0 | 5 |

Regret against the best measured tracked mode (extra time as a fraction of the oracle time):

| policy | loops | mean | 90th percentile | max | weighted by serial time |
| --- | ---: | ---: | ---: | ---: | ---: |
| automatic | 8 | 0.089 | 0.258 | 0.258 | 0.028 |
| serial | 8 | 0.149 | 1.191 | 1.191 | 0.058 |

Geometric mean speedup over all loops (a mode that failed its output check or does not apply counts as serial, 1.00):

| mode | geometric mean | loops above 1.0 |
| --- | ---: | ---: |
| automatic | 1.02 | 1 |
| forced | 0.64 | 1 |
| explicit private contexts | 2.66 | 8 |
| in place, caller declares independence | 1.35 | 2 |
| best exact mode per loop | 3.01 | 8 |

The 2 loops automatic admitted where no tracked route wins, speedup mean and worst:

| route | speedup |
| --- | --- |
| automatic, with the first batch and the bound stop | 0.81 (worst 0.80) |
| forced, dispatching without them | 0.12 (worst 0.10) |

Fixed gate, no fitting (serial work >= 4 ms and cost per record >= 50 us, refusal cost 1.005):

| driver | serial ms | us per record | gate admits | gate time | automatic time | automatic wins by more than 1.05x and the gate refuses |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| blake2b | 10.8 | 42.4 | no | 1.005 | 0.544 | yes |
| brotli-compress | 58.7 | 1222.5 | yes | 1.002 | 1.002 | no |
| brotli-decompress | 7.9 | 122.7 | yes | 1.006 | 1.006 | no |
| md4c-html | 11.6 | 724.4 | yes | 1.004 | 1.004 | no |
| qoa-decode | 0.9 | 28.6 | no | 1.005 | 1.022 | no |
| qoa-encode | 10.8 | 337.1 | yes | 1.005 | 1.005 | no |
| wyhash | 2.8 | 0.7 | no | 1.005 | 1.226 | no |
| yyjson-read | 3.9 | 3.8 | no | 1.005 | 1.258 | no |

| gate | 8 | 0.154 | 1.201 | 1.201 | 0.062 |
| automatic | 8 | 0.089 | 0.258 | 0.258 | 0.028 |
Winners the gate misses: 1.
