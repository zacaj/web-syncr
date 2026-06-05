#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  echo "  e.g. $0 5.3.0"
  exit 1
fi

export DTV="$VERSION"

echo "==> Setting server tag to $VERSION..."
pnpm docker:set-tag

echo ""
echo "==> Restarting on server..."
pnpm docker:compose

echo ""
echo "Deployed v$VERSION successfully."
