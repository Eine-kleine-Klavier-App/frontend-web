#!/usr/bin/env bash
# Rebuilds public/audio/libfluidsynth-2.4.6.mjs: fluidsynth-emscripten v2.4.6-em-2 with
# scripts/fluidsynth-filter.patch, compiled by the emscripten the upstream release was built with
# (3.1.68), so the patch is the only difference from the release. Needs git and Docker.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 --branch v2.4.6-em-2 https://github.com/jet2jet/fluidsynth-emscripten.git "$work/src"
git -C "$work/src" apply "$root/scripts/fluidsynth-filter.patch"
# One make job: the nested table generator breaks on a parallel jobserver inside the container.
docker run --rm -v "$work/src":/src -w /src emscripten/emsdk:3.1.68 bash -c \
  'mkdir build && cd build && emcmake cmake -Denable-oss=off -Denable-libsndfile=off -DCMAKE_BUILD_TYPE=Release .. && emmake make'

{
  cat "$work/src/build/src/libfluidsynth-2.4.6.js"
  printf '\n// Packaging adaptation: expose the upstream Module to ES-module workers.\nexport default Module;\n'
} > "$root/public/audio/libfluidsynth-2.4.6.mjs"
