# picojpeg drivers

Pin: `v10`, commit `f121f69c`. Licence pending: the pin has no LICENSE or README. The only licence text is `picojpeg.h` line 2, "Public domain", and the manifest entry is `licence: pending` until a person decides that is enough.

## Candidates

Rule 1 has zero candidates. This is narrowness: the enumerator parsed both declarations with no unparsed lines, and `pjpeg_decode_init` has no length parameter. Rule 2 applies and gives one candidate, `pjpeg_decode_init`. `pjpeg_decode_mcu(void)` has no pointer parameter, so it is not a candidate.

## Input

`gen_jpeg` copies a 176-byte, 16 by 16 RGB JPEG that is embedded in the driver file. ImageMagick 7.1.2-18 produced it with `magick -size 16x16 gradient:black-white -quality 80 -strip`. Even records are the whole file. Odd records stop at a byte count that changes with the index, so the header parser meets the end of the stream.

The callback serves bytes from the record through `pCallback_data`. The adapter writes the return code and the image info fields, and the number of bytes consumed.
