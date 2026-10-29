# Module Delivery Variants

Each entry registers only the modules its deployment measures, keeping bundles within platform
limits. Use `original`, `boot` or `render` with `local.ts` and `FOLIO_BOOTIMAGE_VARIANT`.
Historical records use `a`, `b` and `c` for those respective variants; the parser accepts both.

| Directory                      | Configuration             | Contents                                 |
| ------------------------------ | ------------------------- | ---------------------------------------- |
| [original](original/README.md) | `wrangler.original.jsonc` | Original PHP and empty-memory controls   |
| [boot](boot/README.md)         | `wrangler.boot.jsonc`     | PHP with the boot image baked in         |
| [render](render/README.md)     | `wrangler.render.jsonc`   | PHP with the after-render image baked in |

See [METHOD.md](../METHOD.md) for preparation, request bounds, instruments and cleanup.
