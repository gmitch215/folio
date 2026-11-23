# Boot

## Overview

`@gmitch215/folio/boot` moves a booted memory into the module. A Wasm interpreter pays for its boot on every cold start, and the heap state it builds is the same each time. `captureImage(booted, fresh)` compares a booted memory with a fresh instance of the same module and keeps the 64 KiB pages that differ. `bakeModule(bytes, image)` returns the module with those pages as active data segments after its own, so instantiating it starts from the booted memory. It uses binaryen, loaded on the first bake, and writes memory 0.

An image is the heap as it was. Anything the booted process held is in the baked module and becomes public with it. State kept in JavaScript, such as handles and open descriptors, is not captured.

Use an image when a guest runs a long, deterministic initialization on every cold start, or a first request that builds caches. The gain for short initializers is small, 1.08x to 1.40x across 21 corpus initializers. A bake prints the pages it kept, and the instance starts with them in place:

```text
[ 0 ] { memoryPages: 1, deltaPages: 1 }
42
```

## Getting Started

This example bakes a module whose boot function writes one word.

```ts
import { bakeModule, captureImage, imagePages } from '@gmitch215/folio/boot';
import binaryen from 'binaryen';

const source = binaryen.parseText(`(module
	(memory (export "memory") 1)
	(func (export "boot") (i32.store (i32.const 0) (i32.const 42))))`);
const bytes = source.emitBinary();
source.dispose();

const module = new WebAssembly.Module(bytes as BufferSource);
const booted = new WebAssembly.Instance(module);
const memory = booted.exports.memory as WebAssembly.Memory;
const fresh = new Uint8Array(memory.buffer).slice();
(booted.exports.boot as () => void)();

const image = captureImage(memory, fresh);
console.log(image.pages, imagePages(image));

const baked = await bakeModule(bytes, image);
const started = new WebAssembly.Instance(new WebAssembly.Module(baked as BufferSource));
const words = new Uint32Array((started.exports.memory as WebAssembly.Memory).buffer);
console.log(words[0]);
```

`captureImage` takes the booted memory and a fresh copy of the same module's memory, as a `WebAssembly.Memory`, an `ArrayBuffer` or a view. A page that boot zeroed but the module's own data had set is stored as zeros, and pages that are zero in both are left out. `imagePages(image)` reports the pages the memory needs and the pages the image carries. The [boot-image example](https://github.com/gmitch215/folio/blob/master/examples/boot-image.ts) is this program with a comment on what the host still owns.

A module can import its memory. The caller then creates it with at least `memoryPages` pages. A defined memory that starts smaller has its initial pages raised to the image size, and its maximum, shared and memory64 flags stay as they are. `bakeModule` writes changed i32, i64, f32 and f64 globals into their initial values and writes memory 0.

## Intermediate

### Identity and Storage

An image records the module it came from and a context. `moduleDigest(bytes)` returns the lowercase sha256 hex that `captureImage` takes as `module`. `context` is a string of 1 to 4,096 UTF-8 bytes, a digest of whatever else shapes the heap, such as settings, shims and assets. `applyImage(memory, image, { module, context })` copies the pages into a fresh instance's memory without baking, and refuses an image whose module or context differs, or that carries none, with `ImageMismatchError` code `digest` or `context`, before it writes a byte. `encodeImage` and `decodeImage` store an image beside the module and reject truncated or unknown input with `ImageFormatError`. `checkBaked(baked, image)` reads the data segments back and compares them with the image without instantiating.

```ts
import {
  ImageMismatchError,
  applyImage,
  bakeModule,
  captureImage,
  checkBaked,
  decodeImage,
  encodeImage,
  imagePages,
  moduleDigest
} from '@gmitch215/folio/boot';
import { readFileSync, writeFileSync } from 'node:fs';

const bytes = Uint8Array.from(readFileSync('./guest.wasm'));
const digest = await moduleDigest(bytes);

// build time: boot one instance on an imported memory and capture it
const fresh = new WebAssembly.Memory({ initial: 1024 });
const booted = new WebAssembly.Memory({ initial: 1024 });
// instantiate `bytes` on each memory, then run the boot sequence on `booted`
const image = captureImage(booted, fresh, { module: digest, context: 'config-7' });
writeFileSync('./guest.image', encodeImage(image));

const baked = await bakeModule(bytes, image);
console.log(checkBaked(baked, image).equal);

// run time: the module and context must match the image, or nothing is written
const stored = decodeImage(Uint8Array.from(readFileSync('./guest.image')));
const memory = new WebAssembly.Memory({ initial: imagePages(stored).memoryPages });
try {
  applyImage(memory, stored, { module: digest, context: 'config-7' });
} catch (error) {
  if (error instanceof ImageMismatchError) console.log(error.code);
}
```

`applyImage` cannot set a module's globals or table slots. An image that records changed ones is refused with code `global` or `table`. `{ memoryOnly: true }` copies the memory anyway and leaves the instance with its fresh globals, which is not a booted instance. A module whose boot changes globals belongs in `bakeModule`. The PHP 8.5.12 build, for one, changes its stack bounds. Pass the global values and a pre-boot copy of the same instance's table references to `captureImage` as `globals` and `table`, and it records what boot changed. Copy the table references before boot on the same instance, because a table from another instance reports every slot changed.

`bakeModule` refuses a module with a start section (code `start`), because the start function would run again over the restored heap. It refuses changed table slots unless `allowTableChanges` is set (code `table`), a wrong module digest (`digest`), a module with no memory (`no-memory`) or with more than one (`memories`), an image over the memory maximum (`maximum`) and a global it cannot rewrite (`global`). Adjacent pages become one segment of at most `maxSegmentBytes`, 64 MiB by default.

### Secrets in an Image

Freed memory is not zeroed, so a secret that was ever in the heap cannot be scrubbed out of an image afterwards. Bake a site whose key and salt are throwaway values, and give the replaying site its own. `findInImage(image, needles)` returns every offset where a needle's bytes occur in the image pages. Search for the secret and for its base64 and hex forms before the module ships.

```ts
import { captureImage, findInImage } from '@gmitch215/folio/boot';

declare const booted: WebAssembly.Memory;
declare const fresh: Uint8Array;
declare const siteKey: string;

const image = captureImage(booted, fresh);
const encoder = new TextEncoder();
const needles = [
  encoder.encode(siteKey),
  encoder.encode(btoa(siteKey)),
  encoder.encode(
    Array.from(encoder.encode(siteKey), (b) => b.toString(16).padStart(2, '0')).join('')
  )
];
if (findInImage(image, needles).length) throw new Error('the image holds the key');
```

A match may span adjacent image pages and never spans a gap, so a needle that straddles a delta page and an unchanged page is not found.

### Renewing State After a Replay

An image replay is correct only for the state it captures, and the host owns the rest. The report's replay-safety contract sorts state into five classes:

- Captured: linear memory and mutable numeric globals. They are stored in the image and restored.
- Renewed: keys and salts, random state, settings, memory caches, cache collectors, and configuration and entity state. The consumer's own code rewrites them before the first request.
- Rebound: streams and named handles. The consumer recreates them by name, and unnamed handles are refused.
- Invalidated: the module set, host driver, file pack, fragments and the module and glue digests. Any change forces a fresh boot.
- Refused: a start function, passive segment drops, Wasm GC objects, reference or vector globals and table slot changes. The library keeps the original bytes or refuses.

For a Drupal heap, three replacements follow the replay. The hash salt lives in the static `Settings` object, the private key lives in the `State` cache collector, which serves it from memory once read, and PHP's Mersenne Twister state is in the heap, so every replayed instance would draw the same `mt_rand()` sequence. Values the bake computed from the old key and salt, such as the permissions hash of the anonymous user, sit in the `cache.memory` bin. This snippet makes the replayed instance use the replaying site's values, with `$salt` set to that site's hash salt:

```php
use Drupal\Core\Site\Settings;

(function (string $salt) {
	$this->storage['hash_salt'] = $salt;
})->call(Settings::getInstance(), $salt);

(function () {
	$this->reset();
	$this->keysSetDuringRequest = [];
})->call(Drupal::state());

Drupal::service('cache.memory')->deleteAll();
mt_srand(unpack('V', random_bytes(4))[1]);
```

Run it before any other PHP in the replayed instance. The bake request's PHP session identifier also stays in the heap, and the library cannot renew it, so the host sets each request's own identifier before it serves the request. A host that resets `State` at the start of each request still needs the salt and the random seed, and needs the key step for code that runs before the first request.

### When an Image Helps

The numbers below are for a PHP 8.5.2 module running a stock Drupal site, from the [Baked Boot Images](../../TECHNICAL_REPORT.md#baked-boot-images) section of the report.

An image taken after boot saves little. Open plus first render in a fresh process took a median of 1,246.6 ms plain and 1,172.8 ms with the boot image, a saving of 74 ms, because functions that the kernel boot compiled now compile during the first render. An image taken after the first render took a median of 372.7 ms, a saving of 874 ms or 70%, and a second context took 276.7 ms against 1,033.7 ms plain.

On a deployed Durable Object Drupal host, the after-render image shipped as static assets cut the first request of a fresh site by 72.0% and 59.9% of cpuTime in two runs, faster in 10 of 10 paired rounds. With PHP 8.5.12 on a paid account the serve step after the interpreter was dropped took a median 555 ms of cpuTime baked against 989 ms plain (43.9% less, 4 objects per arm). The boot image baked into the module saved 22.5% of cpuTime pooled over 8 objects, with a spread wide enough that the report does not count it as a deployed win. Instantiating the baked module takes 4.8 ms for the boot image and 9.1 ms for the after-render image locally, against 3.7 ms unmodified. A deployed Durable Object took 11 ms of cpuTime for the plain module, 16 ms for the boot image and 46 ms for the after-render image, so the cost follows the size of the delta.

For small initializers an image is a modest gain. Across the 21 corpus initializers, restoring an image after instantiation is 1.08x to 1.40x faster than conventional initialization. Generating the Drupal image costs 10.4 s elapsed and 11.4 s of CPU, and by a model that ignores shipping and retention it pays for itself after 27 boots in elapsed time and 19 in CPU.

## Limits

- An image is tied to the module's sha256 and to the context string. A rebuilt interpreter needs a new image. The PHP 8.5.12 rebuild has its own module digest (`3fb16024...b80ce`, 14,011,467 bytes) and its own images, which rendered equal to a booted context in 80 of 80 renders. Two boots of the same module are not byte-identical: 701 bytes of the boot delta and about 4.3 MB of the after-render delta differed between two boots.
- A site boots from the image only when its pack generation, module set, driver and configuration rows all equal the bake's. Any configuration save, module change or driver update sends it to the plain boot, so an image serves unconfigured sites and no site that has changed its configuration. The share of real cold boots that qualifies is not known.
- The Free plan refused the after-render image baked into the module, at a bundle of 64.4 MiB against the 63.9 MiB uncompressed limit. The boot image, 36.6 MiB, deployed. Shipping the delta as static assets deployed and cost 124 to 144 ms of cpuTime per cold object. See [Baked Boot Images](../../TECHNICAL_REPORT.md#baked-boot-images).
- The after-render image presumes the rows its own first render wrote to seven cache and state tables. A fresh seed, two other node sets and a seed that already held those rows all rendered correctly.
- A start function, passive segment drops, Wasm GC objects, reference or vector globals and changed table slots are refused. All 21 corpus modules refuse baking because of the start section, so a fresh instance followed by `applyImage` is the route measured there.
- Configuration eligibility is selective. A strict configuration key admitted 7 of 13 selected configurations and a module key plus the consumer's reset admitted 12 of 13. The set gives no production eligibility rate.
- Copied memory retains sentinel secrets, random state and stale external handles even when `checkBaked` reports equal segments. Renewal and rebinding repair each, and the session identifier is the host's to set on every request. See [Replay-Safety Contract](../../TECHNICAL_REPORT.md#replay-safety-contract).

[Limits](../limits.md) lists the limits that cross modules.

## See Also

- The API reference for `@gmitch215/folio/boot`, generated from `src/boot.ts`.
- [Memory](memory.md) and [Continuation](continuation.md) for the other uses of linear memory.
- [Baked Boot Images](../../TECHNICAL_REPORT.md#baked-boot-images) and [Replay-Safety Contract](../../TECHNICAL_REPORT.md#replay-safety-contract) in the technical report.
- [Boot Images](../studies/boot-images.md) for the studies.
