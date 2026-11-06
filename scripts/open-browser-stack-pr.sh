#!/usr/bin/env bash
# Commit the bumped manifests and open one pull request. Called by
# .github/workflows/browser-stack-bump.yml with VERSION set and GH_TOKEN available.
set -euo pipefail

if git diff --quiet; then
  echo "Already on $VERSION"
  exit 0
fi

branch="chore/browser-stack-$VERSION"
# An open pull request from an earlier run would make the push fail every week.
if git ls-remote --exit-code origin "$branch" >/dev/null 2>&1; then
  echo "Branch $branch already exists on origin; skipping"
  exit 0
fi

git switch -c "$branch"
git add package.json package-lock.json reference-implementation/package.json \
  pdpp-runtime/package.json pdpp-runtime/package-lock.json \
  playwright-runner/package.json playwright-runner/package-lock.json
git commit -s -m "chore(deps): move the browser stack to $VERSION" -m "Assisted-by: AI"
git push origin "$branch"
gh pr create --base main --head "$branch" \
  --title "chore(deps): move the browser stack to $VERSION" \
  --body "Moves patchright, patchright-core and playwright-core to $VERSION in the root, pdpp-runtime and playwright-runner folders. scripts/check-patchright-version.mjs passed before this pull request opened. Close and reopen it to start the pull request checks."
