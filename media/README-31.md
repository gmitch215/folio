# Per-Base Residency Checks With an Epoch Re-Check in a PHP WebAssembly Build

This study builds one translation of a PHP 8.5 WebAssembly module in which the accesses that go
through a base local share one residency check, and measures it against the existing per-access
translation. The check count falls by about a quarter on the heaviest route. The measured
slowdown does not fall to the range the design was expected to reach.

## Design

The translation keeps the per-access arm it starts from: one arena that covers the static data, the
stack window and the first 32 MiB of heap, with a 64 KiB page table for everything outside it.
Stack and static accesses stay exempt. The only change is how the remaining accesses are guarded.

1. Accesses are grouped by base: the local a pointer reads, with `base + constant` folded. A new
   group starts at every `local.set` or `local.tee` of that local.
2. The first access of a group, in evaluation order, carries one check over the group's byte span.
   A forward walk keeps the set of groups whose check has run on every path to the current point
   (intersection at joins, bases written inside a loop dropped at the loop head). Later accesses
   that set covers use the checked base. An access it does not cover keeps the per-access code,
   and so does a group with a single member.
3. The check is one compare against the arena. Outside the arena it calls a shared function that
   returns the page's frame delta, and the group's accesses use `base + delta`.
4. A global epoch word sits one entry past the page table. The host raises it on every eviction.
   After each `call`, `call_indirect` and each lookup that can fault, a function with live groups
   compares the epoch with a local copy. If it moved, the live groups are checked again, together
   with the lookup in progress, until a full round leaves the epoch unchanged. After 8 rounds the
   module traps through the existing slow import with a pointer and offset that wrap and a byte
   count of 7,770,001, so the message differs from any ordinary trap and the host needs no new import.
5. A store whose value is not a constant, local or global reads the base after the value, so a
   re-check inside the value is seen. A store whose value moves its own base is not grouped.

Two choices differ from the first sketch of the design, and both are open:

- A group whose span crosses a page boundary is translated with one host call for the whole span.
  The host accepts it when both pages share a frame delta and traps with "page straddle" when they
  do not, which is the rule the per-access code already applies to a straddling access. A
  per-access fallback would need a second copy of every member's code.
- The loop that hoists lookups of invariant bases already existed. Its keys can evict each other
  when frames are scarce, so the lookups of the earlier keys are now re-run by the same epoch loop.

## Proof

`fixtures.test.ts` runs 19 cases on a small module through a pager that evicts, in two builds (plain
and counting), and compares results and the contents of every page with the untranslated module:
a loop that re-sets its base, a span across a page boundary, eviction inside a callee by `call` and
by `call_indirect`, a re-check cascade that needs two rounds, joins, an early `br_if`, a store that
moves its base, a hoisted loop, and two loops that call. It also checks that a re-check that cannot
settle traps with the distinct message and that a span over frames with different deltas traps with
"page straddle". 41 of 41 pass. Three deliberate breakages each fail some of them: no re-check,
an union instead of an intersection at joins, and the loop liveness bound that the random test
caught first.

`fuzz.test.ts` generates small functions from loads, stores, pointer chasing, ifs, blocks with
`br_if`, bounded loops and faulting calls. 10 seeds of 400 functions, 3 argument sets and 4 pager
configurations each, 48,000 comparisons, 0 failures. The test found three defects before the final
build: a loop bound that missed a group whose check ended just before the loop, a re-check that did
not repeat the lookup in progress, and hoisted keys that evicted each other.

## Module

| Module | Bytes |
| --- | ---: |
| Shipping native module | 14,011,467 |
| Per-access arm | 53,304,560 |
| Epoch arm | 46,695,541 |
| Epoch arm with counters | 61,365,490 |

The epoch arm is 12.4% smaller than the per-access arm. It has 7,148 groups with 200,644 members,
22,516 single-member groups dropped, 271,335 sites left on per-access code and 94,752 re-check sites.
Of the per-access sites that could not be grouped, 239,718 do not read a base local: 203,706 take a
pointer straight from a load, 16,362 from a `local.tee`, and the rest from sums of two expressions.

## Counts

The counting arm exports the translator's counters. Counts are per render, from the counter delta
around the render call. Two runs per route agree to 0.1% or better.

| Route | Accesses | Per-access checks | Group checks | Accesses per group check | Group checks inside the arena | Per-access checks outside the arena |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| admin | 4,404,412,621 | 1,101,779,615 | 14,521,568 | 29.0 | 34.1% | 40.5% |
| flush | 3,816,735,947 | 876,554,998 | 12,365,229 | 15.6 | 27.7% | 41.5% |
| front, cold render | 1,907,976,476 | 459,532,274 | 14,650,752 | 18.7 | 43.8% | 25.3% |

The epoch re-check never ran in these renders (0 rounds): nothing is evicted on the rig.
Every counted render has the same normalized response hash as the untranslated module.

The flush route is counted with the instrumented native module too, with one more change to the
harness (`bench-epcount.diff`): 3,816,863,069 accesses, 1,030,964,571 base checks and 69,646,387
calls, so q is 0.2884.

## Timing

Paired renders on one box, 10 pairs per route and arm, container limited to 6 CPUs and 12 GB,
arms rotated per repetition, a rep started only when the 1-minute load was under 1. Tau is the
paired median of arm over untranslated, minus 1. Intervals are distribution-free median intervals.

| Route | Epoch arm tau | Interval | Per-access arm tau | Interval |
| --- | ---: | --- | ---: | --- |
| front | 1.013 | [0.970, 1.078] | 1.354 | [1.313, 1.398] |
| login | 0.800 | [0.756, 0.871] | 1.038 | [0.959, 1.104] |
| flush | 0.806 | [0.722, 0.868] | 0.786 | [0.747, 0.822] |
| admin | 0.783 | [0.747, 0.828] | 0.834 | [0.751, 0.872] |
| ladder | 0.853 | [0.820, 0.888] | 0.830 | [0.791, 0.891] |

All 150 samples completed and all 100 translated samples return the untranslated module's
normalized HTML (flush returns no HTML). The per-access arm reproduces the published value on four
routes inside this run's interval and sits 0.009 under the interval on flush.

## Limits

- The rig never evicts, so the timing measures the check, not the re-check. The re-check is proven
  on fixtures and random programs only.
- A re-check needs at least as many frames as live groups. Fewer livelocks into the bound trap.
- Accesses folded into a group are slightly more permissive than the per-access code for a pointer
  whose `base + constant` wraps past 4 GiB: such an access traps at the check or at the access, not
  at the same instruction. A negative constant with a positive offset is never grouped.
- The table path of a group is a call. Its cost against an inline lookup was not separated, and the
  cost of the epoch compare at calls was not separated either.
- 10 pairs per cell. Several samples started at a load of 1 or a little above while other jobs shared the box.

## Files

- `elastic-translate.ts`, `elastic-translate-host.ts`: the translator with epoch groups, and its host contract.
- `translate-epoch.diff`: the change against the per-access translator.
- `build-arms.ts`: builds the arms from a module and writes their statistics.
- `pager.ts`, `fixture-lib.ts`, `fixtures.test.ts`, `fuzz.test.ts`: the fixtures and the random test.
- `bench-epcount.diff`: the harness change that reads the counters, including the flush route.
- `run-route.sh`, `run-sweep.sh`: the runners, with placeholder paths.
- `analyze.mjs`: computes the tables from the rows and counts.
- `raw-rows.json`, `summary.json`, `counts.json`: the timed rows, the paired summary and the counted renders.
