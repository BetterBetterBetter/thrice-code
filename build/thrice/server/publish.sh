#!/usr/bin/env bash
# Uploads the tarballs built by build/thrice/server/build.sh to the Forgejo
# generic package registry, at the URL product.json's serverDownloadUrlTemplate
# resolves to:
#
#   $FORGEJO_URL/api/packages/$FORGEJO_OWNER/generic/thrice-server/<commit>/thrice-reh-<os>-<arch>.tar.gz
#
# Usage: FORGEJO_TOKEN=... build/thrice/server/publish.sh [commit]
#   commit defaults to BUILD_SOURCEVERSION, then git HEAD.
#   FORGEJO_URL defaults to https://git.rallen.dev, FORGEJO_OWNER to rallendev.
#   The token needs the write:package scope.
#
# Remote machines download without credentials, so the owner's packages must be
# public (a public user or organization).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

: "${FORGEJO_TOKEN:?set FORGEJO_TOKEN to a token with the write:package scope}"
FORGEJO_URL="${FORGEJO_URL:-https://git.rallen.dev}"
FORGEJO_OWNER="${FORGEJO_OWNER:-rallendev}"
COMMIT="${1:-${BUILD_SOURCEVERSION:-$(git rev-parse HEAD)}}"
OUT_DIR="$ROOT/.build/thrice-server/$COMMIT"

shopt -s nullglob
files=("$OUT_DIR"/thrice-reh-*.tar.gz)
if [[ ${#files[@]} -eq 0 ]]; then
	echo "error: no tarballs in $OUT_DIR; run build/thrice/server/build.sh first" >&2
	exit 1
fi

(cd "$OUT_DIR" && shasum -a 256 -c SHA256SUMS)

base="$FORGEJO_URL/api/packages/$FORGEJO_OWNER/generic/thrice-server/$COMMIT"
for file in "${files[@]}"; do
	name="$(basename "$file")"
	echo "uploading $name"
	curl --fail-with-body --silent --show-error \
		-H "Authorization: token $FORGEJO_TOKEN" \
		--upload-file "$file" "$base/$name"
	echo
	# Confirm that the file downloads without credentials, as a remote would.
	curl --fail --silent --show-error --location --output /dev/null "$base/$name"
done
echo "published ${#files[@]} servers for $COMMIT to $base"
