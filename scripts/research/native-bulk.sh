#!/usr/bin/env bash
# native source-level parallel baseline for the c21 bulk drivers
# usage: native-bulk.sh build ID        compile one driver and write its record file
#        native-bulk.sh run ID THREADS [ROUNDS] [WARMUPS]
#        native-bulk.sh check ID        build, then run at 2 and 4 threads (correctness only)
#        native-bulk.sh statics ID      list the writable file-scope symbols of the library objects
# CC picks the compiler (default clang), NODE the Node 26 binary, NB_OUT the output directory,
# NB_RACY=1 leaves the file-scope scratch of the SHARED drivers as one shared copy
set -euo pipefail
cd "$(dirname "$0")/../.."
cc=${CC:-clang}
node_bin=${NODE:-node}
out=${NB_OUT:-build/research/native-bulk}
cmd=${1:?usage: native-bulk.sh build|run|check|statics ID}
id=${2:?driver id}

build() {
	local dir=$out/$id
	mkdir -p "$dir"
	local plan=() line
	while IFS= read -r line; do plan+=("$line"); done < <("$node_bin" scripts/research/native-bulk-export.ts plan "$id")
	local flags=(-O2 -g0 -DNDEBUG -Dmalloc=nb_malloc -Dfree=nb_free -Dcalloc=nb_calloc -Drealloc=nb_realloc)
	local defines=() include=() sources=()
	for line in "${plan[@]}"; do
		case $line in
			-D*) defines+=("$line") ;;
			-I*) include+=("$line") ;;
			*) sources+=("$line") ;;
		esac
	done
	# the wasm build gets miniz_export.h from its stub include directory, which also shadows libc headers
	printf '#pragma once\n#define MINIZ_EXPORT\n' > "$dir/miniz_export.h"
	# the wasm records hold 32-bit offsets; the native view widens the pointers and nothing else
	local view=$dir/bulk-native.c
	sed 's/uint32_t in, len, aux, arena;/uintptr_t in; uint32_t len; uintptr_t aux, arena;/' \
		scripts/research/cases/c21/bulk.c > "$view"
	grep -q 'uintptr_t in; uint32_t len' "$view" || {
		echo "rec_t line not found in bulk.c" >&2
		exit 1
	}
	case $id in
		jsmn-parse-shared | aes-cbc-decrypt-shared | sha256-shared)
			if [ "${NB_RACY:-0}" != 1 ]; then
				sed -E -i.bak 's/^static (jsmn_parser|jsmntok_t|struct AES_ctx|SHA256_CTX) /static __thread \1 /' "$view"
				grep -q '^static __thread' "$view" || {
					echo "no scratch to make thread-local" >&2
					exit 1
				}
			fi
			;;
	esac
	local objects=() source object
	local index=0
	for source in "$view" ${sources[@]+"${sources[@]}"}; do
		index=$((index + 1))
		object=$dir/$index-$(basename "$source" .c).o
		"$cc" "${flags[@]}" "${defines[@]}" "${include[@]}" -I "$dir" -I "$(dirname "$source")" \
			-w -c "$source" -o "$object"
		objects+=("$object")
	done
	local config=()
	for line in "${defines[@]}"; do
		[ "$line" = -DK_KFFT ] || [ "$line" = -DK_KFFTR ] && config=(-DNB_CONFIG=1)
	done
	"$cc" -O2 -g0 -Wall -Wextra "${defines[@]}" ${config[@]+"${config[@]}"} -c scripts/research/native-bulk.c -o "$dir/harness.o"
	"$cc" -pthread -o "$dir/bin" "$dir/harness.o" "${objects[@]}" -lm
	"$node_bin" scripts/research/native-bulk-export.ts data "$id" "$dir/records.nbk"
}

case $cmd in
	build) build ;;
	run)
		threads=${3:?threads}
		"$out/$id/bin" "$id" "$out/$id/records.nbk" "$threads" "${4:-5}" "${5:-2}"
		;;
	check)
		build
		for t in 2 4; do "$out/$id/bin" "$id" "$out/$id/records.nbk" "$t" 1 0 || true; done
		;;
	statics)
		for object in "$out/$id"/*.o; do
			[ "$(basename "$object")" = harness.o ] && continue
			nm "$object" | awk -v o="$(basename "$object")" '$2 ~ /^[bBdD]$/ {print o, $2, $3}'
		done
		;;
	*)
		echo "unknown command $cmd" >&2
		exit 2
		;;
esac
