# Baked Boot Module

Registers only PHP with its boot image baked into data segments. Prepare from the repository root
with `node experiments/bootimage/prepare.ts`, then run `node experiments/bootimage/local.ts boot`.
Deployment uses `wrangler.boot.jsonc`. The [method](../../METHOD.md) defines checksums, image
prerequisites and request bounds. Historical variant tag: `b`.
