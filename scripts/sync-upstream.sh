#!/usr/bin/env bash
set -euo pipefail

# Sync latest klodr/gmail-mcp into upstream-sync, then merge into your working branch.
# Usage: ./scripts/sync-upstream.sh [target-branch]
# Default target: custom/outreach

TARGET_BRANCH="${1:-custom/outreach}"

git fetch upstream --tags
git checkout upstream-sync
git merge --ff-only upstream/main || {
  echo "Fast-forward failed; upstream-sync has diverged. Resolve manually." >&2
  exit 1
}

git push origin upstream-sync

git checkout "$TARGET_BRANCH"
git merge upstream-sync -m "chore: merge upstream klodr/gmail-mcp into ${TARGET_BRANCH}"

echo "Merged upstream into ${TARGET_BRANCH}. Review, test (npm run build), then push:"
echo "  git push origin ${TARGET_BRANCH}"
