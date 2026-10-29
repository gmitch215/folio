# PHP Deployment

This harness compares the original PHP module with the prepared coordinator and tracked modules
on deployed isolates. It measures compilation, instantiation and memory boundaries separately
from application execution. See the parent [method](../METHOD.md).

Run `node experiments/consumer/php/prepare.ts` from the repository root with
`FOLIO_CONSUMER` pointing at the consumer checkout. Preparation checks the artifact digest before
staging the build. `node experiments/deploy.ts php` and `prepared` run the bounded deployed arms.
Sanitized [records](../../../results/php/deployment/README.md) retain resets and failed combinations.
