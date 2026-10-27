#!/bin/sh
# Installs the wasm-opt tool (from Binaryen) at a fixed version and checks the download against a checksum that is
# written down here. wasm-pack finds wasm-opt on the PATH; without this it would download an unchecked binary and
# use it to rewrite the WebAssembly file that is shipped. Prints the folder to add to the PATH.
#   scripts/install-binaryen.sh   (Linux x86-64 only: it is meant for the CI runners)
set -eu

version=version_117
sha256=3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212
url="https://github.com/WebAssembly/binaryen/releases/download/${version}/binaryen-${version}-x86_64-linux.tar.gz"

dir="${RUNNER_TEMP:-/tmp}/binaryen"
mkdir -p "$dir"
curl --fail --silent --show-error --location --output "$dir/binaryen.tar.gz" "$url"
echo "${sha256}  $dir/binaryen.tar.gz" | sha256sum --check --status || { echo "binaryen checksum mismatch" >&2; exit 1; }
tar -xzf "$dir/binaryen.tar.gz" -C "$dir" "binaryen-${version}/bin/wasm-opt" "binaryen-${version}/lib"
echo "$dir/binaryen-${version}/bin"
