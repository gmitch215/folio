#!/bin/sh
set -eu
repo=richgel999/miniz
commit=293d4db1b7d0ffee9756d035b9ac6f7431ef8492
sha=27d99216e9127d1678085639f3059f6907a02c044e8a38392a39f96163ddbbf0
out=build/research/corpus/miniz.tar.gz
if [ ! -f "$out" ] || ! echo "$sha  $out" | sha256sum -c - >/dev/null 2>&1; then
	mkdir -p build/research/corpus
	curl -fsSL --retry 3 --max-time 120 -o "$out.part" "https://codeload.github.com/$repo/tar.gz/$commit"
	echo "$sha  $out.part" | sha256sum -c - >&2
	mv "$out.part" "$out"
fi
echo "$PWD/$out"
