#!/usr/bin/env bash
set -euo pipefail

BUMP="${1:-}"

if [ -z "$BUMP" ]; then
  echo "Usage: $0 [major|minor|patch|<version>]"
  exit 1
fi

# Extract current version from package.json5
CURRENT=$(grep -oP '(?<=version: ")[^"]+' package.json5)
echo "Current version: $CURRENT"

# Compute new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0; NEW_VERSION="$MAJOR.$MINOR.$PATCH" ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0; NEW_VERSION="$MAJOR.$MINOR.$PATCH" ;;
  patch) PATCH=$((PATCH + 1)); NEW_VERSION="$MAJOR.$MINOR.$PATCH" ;;
  *)     NEW_VERSION="$BUMP" ;;
esac
echo "New version:     $NEW_VERSION"

# Fail fast if there are uncommitted changes (version bump must be a clean commit)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: uncommitted changes present. Commit or stash them before publishing."
  exit 1
fi

echo ""
echo "==> Running tests..."
pnpm test

echo ""
echo "==> Building Docker image..."
export DTV="$NEW_VERSION"
pnpm docker:build

echo ""
echo "==> Tagging and pushing Docker image to registry..."
REGISTRY="docker.zacaj.com/web-syncr"
pnpm docker:tag:push_registry
docker tag web-syncr "$REGISTRY:$MAJOR.$MINOR" && docker push "$REGISTRY:$MAJOR.$MINOR"
docker tag web-syncr "$REGISTRY:$MAJOR"        && docker push "$REGISTRY:$MAJOR"


echo ""
echo "==> Redeploying on server..."
pnpm docker:set-tag
pnpm docker:compose


echo ""
echo "==> Bumping version in package.json5..."
sed -i "s/version: \"$CURRENT\"/version: \"$NEW_VERSION\"/" package.json5

echo ""
echo "==> Committing version bump and tagging git..."
git add package.json5
git commit -m "chore: release v$NEW_VERSION"
git tag "v$NEW_VERSION"
git tag -f "v$MAJOR.$MINOR"
git tag -f "v$MAJOR"
REMOTE=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' | cut -d/ -f1)
git push
git push "$REMOTE" "v$NEW_VERSION"
git push --force "$REMOTE" "v$MAJOR.$MINOR" "v$MAJOR"


echo ""
echo "Published v$NEW_VERSION successfully!"
