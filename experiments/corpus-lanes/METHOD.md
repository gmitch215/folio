# Corpus Lanes Method

Question: does a corpus kernel that wins on shared memory in a bulk loop also win when its records
run on Durable Object lanes that receive learned byte ranges?

## Why a local run predicts a loss

A lane runs the tracked module, which records every byte it reads or writes in a JavaScript set
and map. In-process lanes on an Apple M2 Pro cost 115 to 810 ns per tracked address. The kernels
run 3 ns or less per address natively, so a record is 38 to 400 times slower on a lane than
serial. Overlap across `width` lanes pays only when that ratio is below `width`. This harness
measures it on a deployed lane.

## Cells

Each driver has a `fit` size that keeps every lane request under the default transaction byte
budget (262144 tracked addresses, shared by the calls of one lane request) and an `exceed` size
just over it. Arms: `serial` (`parallel: 'off'`), `ranges-cold` (fresh footprint cache) and
`ranges-warm` (the cache the cold request left in the same isolate). A warm request whose report
shows escape rounds or no footprint hits is cold and is not a warm sample. Exceed cells run
`serial` and `ranges-cold` only.

## Decision rules, fixed before any deployed run

1. Exactness: every sample digest equals the serial digest of the same driver, kind and round.
2. Speedup: per driver, the serial median client wall over the ranges-warm median is at least 1.2.
3. Failures: at most 2% of requests are not a 200.
4. Fit cells: no lane call is exhausted.
5. Exceed cells: a call is exhausted and the owner ran the rest natively, with an exact digest.

Rule 2 failing for every driver is a result: the mechanism is per-address tracking cost.

## Bounds

The plan counts every lane stub call as an invocation. Whether a stub call counts toward the
platform limit of 32 is unverified. Ranges cells need owner CPU above the 10 ms Free Worker limit
by the local estimate, so a live run needs the paid plan the author authorizes. No Durable Object
storage is used. The driver snapshots the account inventory first, retires the class, deletes the
script and fails on any own leftover.
