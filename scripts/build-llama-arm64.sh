#!/usr/bin/env bash
# Builds llama-server for linux-arm64 from a pinned llama.cpp tag, with
# Clang, and packs it like the official release asset
# (llama-<tag>/{llama-server, lib*.so*, LICENSE}), so that fetchRuntime.ts
# and the Desktop's KEEP/DROP filters take it unchanged.
#
# Why: the official b11146 ubuntu-arm64 build (GCC 14, OpenMP) reads
# prompts at 0.73x Ollama's speed on a Raspberry Pi 5 (17.1 vs 23.3 tok/s,
# Qwen3.5 4B Q4_K_M, 571 tokens). Built here with Clang 19 or 21, without
# OpenMP: 22.2 tok/s, the same as Ollama's own llama-server on the same
# GGUF (29/09/2026). See docs/builtin-runtime-design.md, section 1.
#
# Runs natively on an arm64 Linux machine (a Pi, or the ubuntu-24.04-arm
# runner of .github/workflows/llama-runtime-arm64.yml). Nothing is
# installed: the compiler, cmake, git and the OpenSSL headers must be there.
#
#   scripts/build-llama-arm64.sh [--tag b11146] [--variant all] [--work DIR] [--out DIR] [--jobs N]
#
# Variants (the CPU backend of ggml):
#   dotprod       one backend for armv8.2-a+dotprod+fp16 (Pi 5 and newer), ggml's own threads
#   dotprod-omp   the same with OpenMP
#   all           every ARM CPU variant, chosen at run time (like Ollama and the official build),
#                 ggml's own threads: the default, and the one to ship (as fast as dotprod on a Pi 5,
#                 and it still runs on a Pi 4 or any armv8.0 CPU)
#   all-omp       the same with OpenMP
#   dotprod-kleidi  dotprod with Arm's KleidiAI kernels (fetched by ggml's CMake, MD5-checked)
#
# Environment: CC / CXX (default clang / clang++), SOURCE_DATE_EPOCH
# (default: the commit's date), LIBOMP_LICENSE (the licence file shipped
# beside a bundled libomp; by default the distribution's copyright file).
set -euo pipefail

TAG=b11146
VARIANT=all
WORK=
OUT=
JOBS=$(nproc 2>/dev/null || echo 4)
REPO=https://github.com/ggml-org/llama.cpp

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG=$2; shift 2 ;;
    --variant) VARIANT=$2; shift 2 ;;
    --work) WORK=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --jobs) JOBS=$2; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "build-llama-arm64: $*" >&2; exit 1; }

# The commit each tag is built from. A tag can be moved; a commit cannot.
case "$TAG" in
  b11146) SHA=7fe450e19305b828c199d602c23a8337aaa1f03b ;;
  *) die "no pinned commit for tag $TAG (add it here, with the tag's commit from ls-remote)" ;;
esac

KLEIDIAI=OFF
case "$VARIANT" in
  dotprod) ALL_VARIANTS=OFF; OPENMP=OFF ;;
  dotprod-omp) ALL_VARIANTS=OFF; OPENMP=ON ;;
  all) ALL_VARIANTS=ON; OPENMP=OFF ;;
  all-omp) ALL_VARIANTS=ON; OPENMP=ON ;;
  dotprod-kleidi) ALL_VARIANTS=OFF; OPENMP=OFF; KLEIDIAI=ON ;;
  *) die "unknown variant $VARIANT (dotprod, dotprod-omp, all, all-omp, dotprod-kleidi)" ;;
esac

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = aarch64 ] || die "runs on arm64 Linux only (this is $(uname -s) $(uname -m))"

CC=${CC:-clang}
CXX=${CXX:-clang++}
command -v "$CC" >/dev/null || die "no C compiler $CC"
command -v "$CXX" >/dev/null || die "no C++ compiler $CXX"
"$CC" --version | head -1 | grep -qi clang || die "$CC is not Clang"

WORK=${WORK:-$PWD/.cache/llama-arm64/work}
OUT=${OUT:-$PWD/.cache/llama-arm64}
SRC=$WORK/llama.cpp-$TAG
BUILD=$WORK/build-$TAG-$VARIANT
mkdir -p "$WORK" "$OUT"
WORK=$(cd "$WORK" && pwd)
OUT=$(cd "$OUT" && pwd)
SRC=$WORK/llama.cpp-$TAG
BUILD=$WORK/build-$TAG-$VARIANT

# 1. The source, at the pinned commit, checked against the tag.
remote=$(git ls-remote "$REPO" "refs/tags/$TAG" "refs/tags/$TAG^{}")
tagged=$(printf '%s\n' "$remote" | awk -v t="refs/tags/$TAG^{}" '$2 == t { print $1 }')
[ -n "$tagged" ] || tagged=$(printf '%s\n' "$remote" | awk -v t="refs/tags/$TAG" '$2 == t { print $1 }')
[ "$tagged" = "$SHA" ] || die "tag $TAG points to '${tagged:-nothing}', pinned $SHA"

if [ ! -d "$SRC/.git" ] || [ "$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" != "$SHA" ]; then
  rm -rf "$SRC"
  git init -q "$SRC"
  git -C "$SRC" fetch -q --depth 1 "$REPO" "$SHA"
  git -C "$SRC" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi
[ "$(git -C "$SRC" rev-parse HEAD)" = "$SHA" ] || die "checkout is not $SHA"
[ -z "$(git -C "$SRC" status --porcelain)" ] || die "$SRC has local changes"

export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-$(git -C "$SRC" log -1 --format=%ct)}

# 2. Configure: the official release's options (rpath $ORIGIN, backends
# loaded at run time, no -march=native), with the CPU backend of the
# variant, no web UI (Twoody runs llama-server with --no-webui, and the
# prebuilt UI would be fetched unpinned), and only the targets we ship.
GENERATOR=()
command -v ninja >/dev/null && GENERATOR=(-G Ninja)
CPU_ARGS=(-DGGML_CPU_ALL_VARIANTS="$ALL_VARIANTS")
[ "$ALL_VARIANTS" = OFF ] && CPU_ARGS+=(-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16)
PREFIX_MAP="-ffile-prefix-map=$SRC=. -ffile-prefix-map=$BUILD=build"

CMAKE_ARGS=(
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_C_COMPILER="$CC"
  -DCMAKE_CXX_COMPILER="$CXX"
  -DCMAKE_C_FLAGS="$PREFIX_MAP"
  -DCMAKE_CXX_FLAGS="$PREFIX_MAP"
  '-DCMAKE_INSTALL_RPATH=$ORIGIN'
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
  -DBUILD_SHARED_LIBS=ON
  -DGGML_BACKEND_DL=ON
  -DGGML_NATIVE=OFF
  "${CPU_ARGS[@]}"
  -DGGML_OPENMP="$OPENMP"
  -DGGML_CPU_KLEIDIAI="$KLEIDIAI"
  -DLLAMA_BUILD_NUMBER="${TAG#b}"
  -DLLAMA_BUILD_COMMIT="${SHA:0:9}"
  -DLLAMA_BUILD_UI=OFF
  -DLLAMA_USE_PREBUILT_UI=OFF
  -DLLAMA_BUILD_TESTS=OFF
  -DLLAMA_BUILD_EXAMPLES=OFF
  -DLLAMA_OPENSSL=ON
)
cmake -S "$SRC" -B "$BUILD" "${GENERATOR[@]}" "${CMAKE_ARGS[@]}"

# The CPU backends are modules nothing links to: named explicitly.
# (Ninja lists "name: phony", Make "... name".)
mapfile -t CPU_TARGETS < <(cmake --build "$BUILD" --target help | sed -E 's/^\.\.\. //; s/:.*$//' | grep -E '^ggml-cpu(-[A-Za-z0-9._]+)?$' | grep -v -- '-feats$' | sort -u)
[ ${#CPU_TARGETS[@]} -gt 0 ] || die "no ggml-cpu target"
cmake --build "$BUILD" --config Release -j "$JOBS" --target llama-server llama-bench "${CPU_TARGETS[@]}"

# 3. Pack like the official asset: one folder llama-<tag>/.
ASSET=llama-$TAG-bin-ubuntu-arm64-clang-$VARIANT.tar.gz
STAGE=$WORK/stage-$VARIANT
PKG=$STAGE/llama-$TAG
rm -rf "$STAGE"
mkdir -p "$PKG"
cp -P "$BUILD"/bin/llama-server "$BUILD"/bin/llama-bench "$PKG"/
cp -P "$BUILD"/bin/lib*.so* "$PKG"/
cp "$SRC/LICENSE" "$PKG/LICENSE"

# Clang's OpenMP is LLVM's libomp, absent from most systems: shipped
# beside the libraries (the runtime filter keeps lib*omp*), with its licence.
if [ "$OPENMP" = ON ]; then
  needed=$(readelf -d "$PKG"/libggml-cpu*.so | awk '/NEEDED/ && /libomp/ { gsub(/[][]/, "", $NF); print $NF; exit }')
  if [ -n "$needed" ]; then
    omp=$("$CC" -print-file-name="$needed")
    [ -f "$omp" ] || omp=$(ldd "$PKG"/libggml-cpu*.so | awk -v n="$needed" '$1 == n && $3 ~ /^\// { print $3; exit }')
    [ -f "$omp" ] || die "$needed not found"
    cp -L "$omp" "$PKG/$needed"
    licence=${LIBOMP_LICENSE:-$(ls /usr/share/doc/libomp5*/copyright 2>/dev/null | head -1 || true)}
    [ -f "$licence" ] || die "libomp is bundled but no licence file was found (set LIBOMP_LICENSE)"
    cp "$licence" "$PKG/LICENSE-libomp"
  fi
fi

for file in "$PKG"/llama-server "$PKG"/lib*.so*; do
  [ -L "$file" ] && continue
  missing=$(ldd "$file" | grep 'not found' || true)
  [ -z "$missing" ] || die "$(basename "$file"): $missing"
done
version=$("$PKG/llama-server" --version 2>&1 || true)
case "$version" in
  *"build ${TAG#b}, commit ${SHA:0:7}"*) ;;
  *) die "llama-server does not report build ${TAG#b}, commit ${SHA:0:7}: $version" ;;
esac

{
  echo "llama.cpp $TAG ($SHA)"
  echo "variant: $VARIANT"
  echo "compiler: $("$CC" --version | head -1)"
  echo "cmake: $(cmake --version | head -1)"
  echo "glibc: $(ldd --version | head -1)"
  printf 'option: %s\n' "${CMAKE_ARGS[@]}"
} > "$PKG/BUILDINFO"

find "$PKG" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner --format=gnu \
  -C "$STAGE" -cf - "llama-$TAG" | gzip -n -9 > "$OUT/$ASSET"
(cd "$OUT" && sha256sum "$ASSET" > "$ASSET.sha256" && cat ./*.tar.gz.sha256 > SHA256SUMS)
echo "built $OUT/$ASSET"
cat "$OUT/$ASSET.sha256"
