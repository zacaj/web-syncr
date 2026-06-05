#!/usr/bin/env bash
set -euo pipefail

export DTV="dev"

echo "==> Type-checking..."
pnpm typecheck

echo ""
echo "==> Building and pushing Docker image as :dev..."
pnpm docker:build_push

echo ""
echo "==> Setting server tag to dev..."
pnpm docker:set-tag

echo ""
echo "==> Restarting on server..."
pnpm docker:compose

echo ""
echo "Deployed dev build successfully (tag: dev)."
