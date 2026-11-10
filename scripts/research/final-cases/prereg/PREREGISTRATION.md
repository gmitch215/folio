# Final corpus pre-registration

Status: draft written 2026-11-10. The commit that adds this file together with the files it names is the freeze. No Folio run on any driver of this corpus exists before that commit, and none has been made.

## What this fixes

The selection of the drivers, the pass thresholds, what is reported, and what happens if any of it changes after an outcome is seen. The evaluation compares Folio's automatic route with serial execution of the same drivers.

## Frozen inputs

| Input                               | Where                                                  | Hash (SHA-256)                                                                               |
| ----------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Enumeration script                  | `scripts/research/corpus-enumerate.ts`                 | `6122d1df1b1ab8659117c47b712187f0035bad801472e374244788dd466d9de2`                           |
| Enumeration output                  | `scripts/research/final-cases/prereg/enumeration.json` | `1a9e3def160681695b02f46e39f0c9d5d410eb81ead3df4b4f67f5b6520fc2e6`                           |
| Draw script                         | `scripts/research/final-cases/draw.ts`                 | `0243e4beebf031ea195b493ced43b4caf95b564459dc2593be1d052ad0e24303`                           |
| Candidate list for the draw         | `scripts/research/final-cases/prereg/candidates.json`  | `f460a93d9461d11dd899b293574613b212ad88ce48498a2342409730699c884d`                           |
| Draw result                         | `scripts/research/final-cases/prereg/draw.json`        | `17556590ee33db6dc92f602ad50891f04da2a713b494c04fabfd1164cfc99d6a`                           |
| Driver manifest                     | `scripts/research/final-cases/final-manifest.json`     | `6ce1bef9fb9fe7d2a85ec56e544240656be266bb169ecc2a82218747c9e6ee9d`                           |
| Shared libc shim and config headers | `scripts/research/final-cases/shim/`, `config/`        | combined digest `4eefbdd4d092133bda078e275946e5e11e8ee6aa9c07ec233395e817393582db`, 72 files |

The manifest records, for every project, the repository, the release tag or commit, the commit hash, the licence file, a hash of the tracked file listing and a digest of the vendored sources. Third-party sources are vendored verbatim under `scripts/research/final-cases/upstream/`.

## Selection

A project enters the pool only if all five hold at its pinned revision: it is C, judged from the sources; its licence is named in a file at that revision and a person has not been asked to choose between licences; it has a release tag or a commit hash and date in the manifest; it builds to WebAssembly under the shared shim and the project's fixed config header; and it supplies no driver of the development corpus.

Candidate functions come from the enumeration script, run over the public headers listed in the manifest. A declaration whose leading all-caps macro contains `PRIVATE` or `INTERNAL` is not public and is excluded with that reason. The rules that choose adapted candidates, in the order they were fixed:

1. Rule 1 (fixed before any build). A candidate is a non-static function declared in a public header with at least one pointer parameter and at least one integer length or size parameter after a pointer. The size test is a case-insensitive name match on `len`, `size` or `count`, or a `size_t` parameter. Candidates are taken in enumeration order, first 12 per project.
2. Rule 2 (added 2026-11-10 08:30 EST, after the enumeration counts and before any Folio run). A project with no rule 1 candidate uses non-static functions with at least one non-const pointer parameter, first 12. Ryu, minimp3, pffft and picojpeg used it. Each had no candidate under rule 1 because of the rule's narrowness, not a parse failure. Siphash has no public header and contributes nothing.
3. Rule 1b (added 2026-11-10 10:55 EST, before any Folio run). The 12-candidate window counts only candidates with a definition in the default build. A candidate with no definition is skipped as `compiled-out`. Window selection for batch A projects did not change.

A candidate that is not adapted is recorded with one reason from a closed list: `over-cap`, `compiled-out`, `needs-context-init`, `needs-file-api`, `needs-threads`, `output-unbounded`, `no-input-buffer`, or `other:<text>`.

A driver is eligible for the draw only if it builds, runs under plain WebAssembly in Node, is stable across three runs, and its output slots equal a native arm64 build of the same adapter slot for slot. A driver that fails any of these is excluded and reported. This filter uses no Folio outcome.

## Driver layout

Every driver follows the host ABI of the development corpus. Its unshared linear memory is imported from `env.memory` and re-exported as `memory`, and it exports `prepare` and `bulk`. The final corpus uses an initial 4096 and a maximum 8192 pages for every driver, because the development corpus's 128 and 1024 pages cannot hold 65 slices of 2 MiB. Each record has its own arena slice, set through `bump_set` at the start of the record as in the development drivers, with no zeroing. The slice size per driver (ARENA) is the smallest power of two that is at least twice the peak bytes any record of that driver allocates in the serial run, with a floor of 64 KiB, measured with a counting copy of the shim. The rule was written before the measurement. Of the 109 drivers, 94 have 64 KiB, 5 have 128 KiB, 3 have 256 KiB, 6 have 2 MiB (libdeflate compress), and zopfli has 512 MiB. The generator slice follows the same rule as `genArena`.

Recording against this layout changed no checksum. All 107 drivers that run give the same slot checksums when their records run in a seeded shuffled order and in two interleaved halves on separate memories in plain WebAssembly. That is the minimum a parallel route needs and is not a parallel run.

## The draw

The draw runs `draw.ts` on `candidates.json` with the seed string `folio-v1.1-final-corpus` and a cap of 6 drivers per project. Input order is sorted by driver id. The generator is sfc32 seeded from the first four 32-bit words of the SHA-256 of the seed. Each project's eligible drivers are shuffled with Fisher-Yates and the first 6 are drawn. A project with fewer than 6 contributes all of them. The seed was fixed before the draw was run, and the draw was run once on this pool.

Result: 47 drivers from 10 projects (libdeflate 6, cJSON 6, tinycbor 6, mpack 6, stb 6, nanopb 5, base64 4, ryu 4, minimp3 2, pcre2 2). Not drawn: 18 for `over-cap`, 2 `build-failed` (zopfli `ZopfliCompress`, because one record allocates 152,744,208 bytes and the shim's `free` is a no-op, so a per-record arena of the size the rule gives would need about 34 GB, over the wasm32 limit; and minimp3 `mp3dec_f32_to_s16`, which is compiled out under the default configuration), and 2 `native-not-equal` (stb `stbds_hash_bytes` and `stbds_hash_string`, which branch on `sizeof(size_t)`, diagnosed from source only).

## Not in the pool

Five projects built and match native but their licence is pending a decision by a person, so they are outside the draw: zstd (BSD or GPL-2.0), dr_libs (Unlicense or MIT-0), pffft (BSD-like with a name-use clause), picohttpparser and picojpeg (no licence file at the pin). Their results are in `candidates-pending.json`. If a person clears any of them, the candidate file and draw are regenerated with the same seed and cap, and the numbers above change. Three projects failed the build under the shim: libexpat, quickjs-ng and jq. The pool has 10 projects, short of the target of 12.

## Pass thresholds

The run passes only if all three hold.

1. The geometric mean of per-driver speedup over every driver of the draw is at least 1.20. A refused driver counts with the measured ratio of the path that ran, which includes the refusal check and the serial fallback. It does not count as 1.00.
2. Ranking drivers by speedup, the slowest 10 percent (rounded up to whole drivers) each have speedup at least 0.90.
3. The number of wrong outputs over every driver and input is zero. One wrong output fails the run.

Speedup is the median of paired per-round ratios, serial time over Folio time, for the same driver, input and session. The serial arm is the same Wasm module run serially in plain WebAssembly in Node 26. The native arm64 build is a correctness oracle only.

## Inputs and measurement

Each driver has its input generator, record count, slot size and arena size in `final-manifest.json`. Generators are deterministic and committed. Measurement is on a quiet host with a fresh process per arm, arms interleaved, three sessions, two architectures, per-driver paired intervals, CPU and memory recorded, and the load average at the start and end of every sample. A sample over 50 times its arm's median is kept in the raw files and reported, and the medians are reported with and without it.

Arms: serial, Folio automatic (the router of W3), and the five ablation modes (certified summary alone, certified window alone, both as independent analyses, both with one shared analysis, and the complete router). Baselines from other systems are reported where they exist, and an arm that cannot run a driver is counted in the denominator as unsupported.

## What is reported

Every driver of the enumeration, drawn or not, with its project, pin, rule, reason for being drawn or not, and the seed. Every refusal with its reason class. Every slowdown with its ratio and interval. The full distribution of per-driver speedup, not only the three thresholds. Build failures and unsupported arms. Any driver dropped after the run, with its reason and the number of drops beside the result.

## Development rule

Outcomes on this corpus may not guide tuning. If a threshold, a router rule, a refusal rule, the driver list or an input set changes after any outcome on this corpus has been examined, this corpus becomes a development set, its results are reported as development results, and a new corpus is drawn with a new seed from an enumeration rerun on the same pins. Examining outcomes to decide whether to change anything counts as tuning, even when nothing changes. The Folio revision used for the evaluation is recorded at its start. A change to Folio after the first final-corpus outcome falls under this rule.

## Known limits of this selection

- The shim grew during the work while compile errors were read on the same pool the count uses, so the pool is not an independent draw from all C projects.
- The first-12 window and the name match on the size parameter are mechanical choices. Under the literal reading of "integer parameter" the candidate sets would be larger. Rule 1 was not changed to that reading.
- The enumerator is a token scan, not a C parser. It lists function-like macros and declarations built by macros as unparsed. pcre2's core API sits in macro bodies, so pcre2 contributes 2 candidates. ryu's `ryu2.h` and stb's `stb_vorbis.c` are not in the header list.
- Preprocessor branches merge statements in at least three places of `mpack-common.h`. No other count of this was made.
- Two mpack drivers in the window are no-op inline wrappers. They are legitimate candidates under rule 1b and are kept.
- The native comparison for stb's two hash drivers could not be checked against a 32-bit native control on this host.
- Configuration choices on both sides: `PFFFT_SIMD_DISABLE`, `ZSTD_LEGACY_SUPPORT=0`, `-DMINIMP3_NO_SIMD` on the native build, `-ffp-contract=off` on the native build of pffft and dr_libs, `-U__aarch64__` on the native build of libdeflate, `-DHAVE_CONFIG_H` for pcre2. The picojpeg input was made with ImageMagick.
- The corpus is selected for drivers that run as stateless loops over records with the shim's arena allocator. It says nothing about applications.
