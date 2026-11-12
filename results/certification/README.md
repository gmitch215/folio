# Certification

Evidence for how far a compiled byte-stream function can be certified as safe to split across
workers. The studies run the spike checkers (`scripts/research/stream-check.ts` and
`scripts/research/loop-check.ts`) against constructed hazards, a red-team corpus and real compiled
kernels, and record what they accept, what they refuse and where a sampling probe or exact mode
returns a wrong state. They are the baseline for the stream certifier in `src/certify.ts`, whose
study runs the same corpora and two further rounds of review.

- [split-sensitivity](split-sensitivity/README.md)
- [checker-redteam](checker-redteam/README.md)
- [loop-census](loop-census/README.md)
- [stream-certifier](stream-certifier/README.md)
- [stream-verifier](stream-verifier/README.md)
- [adversary-round-four](adversary-round-four/README.md)
