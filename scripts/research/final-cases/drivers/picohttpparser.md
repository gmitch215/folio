# picohttpparser drivers

Pin: `v1.5`, commit `54413dc6`. Licence pending: the pin has no LICENSE file. `README.md` says the code is dual-licensed under the Perl License or the MIT License, which is a statement and not a licence file. The manifest entry is `licence: pending`. The project stays out of the draw pool until it is cleared.

## Candidates

Rule 1 gives three: `phr_parse_request`, `phr_parse_response`, `phr_parse_headers`. All three are adapted, so nothing is skipped.

## Generators

- `gen_request`: `GET /r<i> HTTP/1.1`, a `Host` line, then `1 + i % 16` lines `X-H<k>: v<7i + k>`, then the blank line.
- `gen_response`: `HTTP/1.1 <200 + i % 4> Reason`, then the same header lines, then the blank line.
- `gen_headers`: the header lines and the blank line, with no start line.

Records are 128, sized to 512 bytes. A record's input is text, so the dev byte pattern is not used.

## Adapters

Each adapter writes the return value in word 0 and scalars in words 1 to 6. Header tables go in `DATA(out)`, four words per header, as offsets into the record input. Pointers are never written.
