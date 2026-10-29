# Counted-Loop Extraction

The browser adapter derives partitions from a trusted prepared plan, checks disjoint byte
footprints, and joins shared-memory workers before returning. It needs no JSPI for this subset.

From the repository root, run `node experiments/browser/extraction/prepare.ts`, then
`node experiments/browser/extraction/local.ts`. The local driver requires Playwright Chromium;
`FOLIO_PLAYWRIGHT_PACKAGE` can select an existing installation. The parent [method](../METHOD.md)
describes deployment. [Evidence](../../../results/browser/extraction/README.md) separates local
controls, JSPI removal and deployed measurements.
