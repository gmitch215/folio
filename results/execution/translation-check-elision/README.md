# Translation Check Elision

Question: how many of the translated module's checked accesses can static analysis prove in range, and does removing those checks lower tau on the PHP routes?

Result: sound grouping reaches at most 32.4% of the checked accesses on the stock front (237,281,097 of 732,848,870), so tau stays at 1.06 or worse even at zero cost per elided access. The built arm `g-bcd`, which groups the class A accesses (10.6% of checked accesses), reads 1.569 [1.505, 1.621] on the front against 1.524 for `bcd` in the same run, where the cost model predicted 1.39 to 1.41. The cause of the miss is undiagnosed. `g-bcd` lowers the other routes: Thunder login 1.142, admin 0.885, ladder 1.010. With no access checked (`floor`), tau is 0.039, so the checks are the tax. A range test costs about 72% of a full lookup. G-tau remains NOT MET.

Class shares of the checked accesses on the stock front: A 10.6%, R 14.8%, O 7.3%, C 0.1%, D 2.2%, E 7.0%, F 7.9%, G 50.2%. The upper bound adds the classes A, R, C and E.

## Inputs

| Path | Contents |
| --- | --- |
| `census-analysis-1.json` to `census-analysis-4.json` | dynamic access census by class; the fourth is the one quoted |
| `main/summary-all.json`, `main/raw/all.jsonl` | `bcd` against `g-bcd` on five routes, 12 pairs each |
| `elide1/summary-all.json`, `elide1/raw/all.jsonl` | `floor`, `bcd`, `r-all` and `r-heap32` on the front (`bcd` reads 1.547 here, 1.524 in `main`) |
| `elide2/`, `elide3/` | run logs and host samples of the later repeats |
| `model-1.json` | the cost model that predicted 1.39 to 1.41 |

## Instrument

`scripts/research/elastic-elide.ts` and `elastic-walk.ts` build the arms and the census. Timing is `translation-tau2-summary.ts` on the quiet rig of [translation-tau-rig](../translation-tau-rig/README.md).

## Limits

In the `main` run 55 of 180 samples started at a one-minute load of 1.0 or over (maximum 1.33), and in `elide1` 23 of 60 (maximum 1.36). Other routes' census was not measured, so the 32.4% bound is the stock front's. The Thunder routes lose about 0.2 of tau with `g-bcd` for a reason the front census does not explain.
