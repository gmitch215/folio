# Forced Admission, Interrupted

Zero-threshold diagnostic that stopped before the last five cases ran. 16 of 21 case records reached
close. The [complete study](../forced-admission-complete/README.md) supersedes it. Keep the raw rows
as recorded and do not use this record as a denominator or for speedup conclusions.

Reproduce with `FOLIO_CORPUS_ADMISSION=0 node scripts/research/corpus-serial.ts build/research/forced-repeat 9`.
This admits candidate regions for diagnosis; production defaults are unchanged.
