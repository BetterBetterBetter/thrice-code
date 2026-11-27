#!/usr/bin/env bash
# Builds Thrice remote servers (vscode-reh) and packages them as the tarballs
# that open-remote-ssh downloads through product.json's serverDownloadUrlTemplate:
#
#   .build/thrice-server/<commit>/thrice-reh-<os>-<arch>.tar.gz
#
# Usage: build/thrice/server/build.sh [target...]
#   targets: linux-x64 linux-arm64 darwin-x64 darwin-arm64
#   default: linux-x64 linux-arm64
#
# Linux targets build inside Docker, because the server's native
# modules must be compiled for the target OS. Darwin targets build on the host
# and must run on macOS.
#
# The server only connects to a client stamped with the same commit, so build
# the client from the same checkout. The commit is BUILD_SOURCEVERSION if it is
# set, otherwise git HEAD. Uncommitted changes are built in but do not change
# the commit, so commit before building a release.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

COMMIT="${BUILD_SOURCEVERSION:-$(git rev-parse HEAD)}"
if ! [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
	echo "error: commit '$COMMIT' is not a 40-character SHA" >&2
	exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
	echo "warning: the working tree has uncommitted changes; they are built in but the server is stamped $COMMIT" >&2
fi

SERVER_APP_NAME="$(node -p 'require("./product.json").serverApplicationName')"
OUT_DIR="$ROOT/.build/thrice-server/$COMMIT"
NODE_VERSION="$(tr -d '[:space:]' < .nvmrc)"
mkdir -p "$OUT_DIR"

TARGETS=("$@")
if [[ ${#TARGETS[@]} -eq 0 ]]; then
	TARGETS=(linux-x64 linux-arm64)
fi

# Packs the gulp output folder into thrice-reh-<target>.tar.gz with a single
# top-level folder, which server-setup.sh strips with --strip-components 1.
package() {
	local target="$1" built="$2"
	if [[ ! -x "$built/bin/$SERVER_APP_NAME" ]]; then
		echo "error: $built/bin/$SERVER_APP_NAME is missing" >&2
		exit 1
	fi
	local stamped
	stamped="$(node -p 'require(process.argv[1]).commit' "$built/product.json")"
	if [[ "$stamped" != "$COMMIT" ]]; then
		echo "error: $built/product.json is stamped '$stamped', expected $COMMIT" >&2
		exit 1
	fi
	local staging
	staging="$(mktemp -d)"
	ln -s "$built" "$staging/thrice-server-$target"
	tar -czhf "$OUT_DIR/thrice-reh-$target.tar.gz" -C "$staging" "thrice-server-$target"
	rm -rf "$staging"
	echo "packaged $OUT_DIR/thrice-reh-$target.tar.gz"
}

build_darwin() {
	local target="$1"
	if [[ "$(uname -s)" != "Darwin" ]]; then
		echo "error: $target must be built on macOS" >&2
		exit 1
	fi
	local arch="${target#darwin-}"
	local host_arch
	host_arch="$(node -p 'process.arch')"
	if [[ "$arch" != "$host_arch" ]]; then
		export npm_config_arch="$arch"
	fi
	pnpm install --frozen-lockfile
	node build/lib/builtInExtensions.ts
	BUILD_SOURCEVERSION="$COMMIT" pnpm run gulp "vscode-reh-$target-min"
	package "$target" "$(cd "$ROOT/.." && pwd)/vscode-reh-$target"
}

build_linux() {
	local target="$1"
	local arch="${target#linux-}"
	local docker_arch
	case "$arch" in
		x64) docker_arch="amd64" ;;
		arm64) docker_arch="arm64" ;;
		*) echo "error: unsupported arch '$arch'" >&2; exit 1 ;;
	esac
	# Debian bullseye (glibc 2.31) keeps the native modules loadable on
	# Ubuntu 20.04+, Debian 11+ and RHEL 9+. Docker publishes bullseye only
	# per major, not per patch, and build/npm/preinstall.ts requires the exact
	# .nvmrc version, so the official binary for that version is installed over
	# the image's node.
	local image="node:${NODE_VERSION%%.*}-bullseye"

	docker run --rm --platform "linux/$docker_arch" \
		-v "$ROOT:/src:ro" \
		-v "$OUT_DIR:/out" \
		-e BUILD_SOURCEVERSION="$COMMIT" \
		-e TARGET="$target" -e SERVER_APP_NAME="$SERVER_APP_NAME" \
		-e NODE_VERSION="$NODE_VERSION" -e NODE_ARCH="$arch" \
		-e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
		"$image" sh -euc '
			apt-get update
			apt-get install -y --no-install-recommends git python3 make g++ pkg-config libkrb5-dev libsecret-1-dev libxkbfile-dev
			node_tar="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
			mkdir -p /tmp/node && cd /tmp/node
			curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/$node_tar"
			curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
			grep " $node_tar\$" SHASUMS256.txt | sha256sum -c -
			tar -xJf "$node_tar" -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md
			cd /
			test "$(node -v)" = "v$NODE_VERSION"
			mkdir -p /work/repo
			# tar rather than rsync: bullseye is past LTS and its security pool
			# returns 404 for some packages. "./" patterns match the top level only.
			tar -C /src --exclude=node_modules --exclude=./.build --exclude="./out*" -cf - . | tar -C /work/repo -xf -
			cd /work/repo
			git config --global --add safe.directory /work/repo
			corepack enable
			pnpm install --frozen-lockfile
			node build/lib/builtInExtensions.ts
			pnpm run gulp "vscode-reh-$TARGET-min"
			mkdir -p /work/stage
			mv "/work/vscode-reh-$TARGET" "/work/stage/thrice-server-$TARGET"
			test -x "/work/stage/thrice-server-$TARGET/bin/$SERVER_APP_NAME"
			tar -czf "/out/thrice-reh-$TARGET.tar.gz" -C /work/stage "thrice-server-$TARGET"
			chown "$HOST_UID:$HOST_GID" "/out/thrice-reh-$TARGET.tar.gz"
		'
	echo "packaged $OUT_DIR/thrice-reh-$target.tar.gz"
}

for target in "${TARGETS[@]}"; do
	case "$target" in
		darwin-x64|darwin-arm64) build_darwin "$target" ;;
		linux-x64|linux-arm64) build_linux "$target" ;;
		*) echo "error: unknown target '$target'" >&2; exit 1 ;;
	esac
done

(cd "$OUT_DIR" && shasum -a 256 thrice-reh-*.tar.gz > SHA256SUMS)
echo "built servers for $COMMIT in $OUT_DIR"
