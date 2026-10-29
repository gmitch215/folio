# Baked Render Module

Registers only PHP with its after-render image baked into data segments. Prepare from the repository
root with `node experiments/bootimage/prepare.ts`, then run `node experiments/bootimage/local.ts render`.
Deployment uses `wrangler.render.jsonc`. The [method](../../METHOD.md) defines checksums, image
prerequisites and request bounds. Historical variant tag: `c`; a refused upload remains a result.
