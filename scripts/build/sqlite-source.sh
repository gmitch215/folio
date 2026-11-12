#!/bin/sh
set -eu
dir=build/sqlite-amalgamation-3500400
sha=1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032
if [ ! -f "$dir/sqlite3.c" ]; then
	mkdir -p build
	curl -fsSL --retry 3 -o build/sqlite-amalgamation.zip https://www.sqlite.org/2025/sqlite-amalgamation-3500400.zip
	echo "$sha  build/sqlite-amalgamation.zip" | sha256sum -c - >&2
	unzip -q -o -j build/sqlite-amalgamation.zip -d "$dir"
fi
echo "$PWD/$dir"
