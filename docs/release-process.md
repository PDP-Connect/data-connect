# GitHub release process (deterministic)

## Just do this

```bash
# Replace <version> with the version you are releasing (example: 0.8.1)
git checkout main
git pull --ff-only origin main
npm run release:github -- --version <version>
```

That is the full release flow for normal releases.

## What this command does automatically

`npm run release:github -- --version <version>` performs all of this in order:

1. Validate `git` and `gh`, and `gh` auth
2. Require clean working tree
3. Require current branch equals target branch (`main` by default)
4. `git pull --ff-only origin <target>`
5. Bump `src-tauri/tauri.conf.json` version
6. `git add src-tauri/tauri.conf.json`
7. `git commit -m "release: vX.Y.Z"`
8. `git push origin <target>` (unless `--no-push`)
9. `gh release create vX.Y.Z --target <target> ...`

Creating the GitHub release triggers `.github/workflows/release.yml` (`on: release: created`) to:

1. Build and upload the desktop manual-install artifacts.
2. After the desktop artifacts upload, build and publish the public Core image to GHCR as `ghcr.io/pdp-connect/data-connect/core:<version>`. Every release publishes its version tag, prereleases included.
3. For stable releases only, a serialized job (`core-image-latest-promotion` concurrency group) moves `core:latest` to this release's exact image digest if its version is strictly newer (SemVer) than the `org.opencontainers.image.version` label on the current `core:latest`. If `core:latest` does not exist yet, the job creates it. If the current version cannot be read, the job fails and leaves `latest` unchanged.

For example, `v1.5.1` publishes `core:1.5.1` and moves `core:latest` only if `latest` is older than 1.5.1. Re-running an older release publishes its version tag again but does not move `latest` back. GitHub keeps at most one pending job in the concurrency group, so a newer pending promoter can replace an older one and the replaced job shows as cancelled. Re-run a cancelled promoter if needed; re-running is safe.

## Direct answers (branch + tag confusion)

- **Do I create a new branch first?**  
  **No** for normal releases. Run this from `main`. The script enforces that.
- **Do I commit the version bump manually?**  
  **No** if you use `npm run release:github`; it commits for you.
- **When is the GitHub release tag created?**  
  At the end of that same command via `gh release create ...`.
- **Is there another npm release command after push?**  
  **No.** `npm run release:github` already does push + release creation.

## Normal release (recommended)

Use the exact `Just do this` block above.

## Safe preview before releasing

```bash
npm run release:github -- --version <version> --dry-run
```

## Preflight helpers

Show current/suggested versions:

```bash
npm run release:versions
```

Validate version ordering only:

```bash
npm run release:github -- --version <version> --check-version
```

## If you insist on release branch + PR first

This is manual and **not** what the default script flow expects.

1. On feature branch, bump `src-tauri/tauri.conf.json`, commit, open PR, merge to `main`.
2. After merge, run release command from `main`:

```bash
git checkout main
git pull --ff-only origin main
npm run release:github -- --version <version>
```

Do **not** run `npm run release:github` on a non-target branch unless you intentionally set `--target` to that branch.

## Options

- `--version X.Y.Z` (required unless using helper flags only)
- `--target main` (default `main`; current branch must match)
- `--title "DataConnect vX.Y.Z"` (optional)
- `--notes "Release vX.Y.Z"` (optional)
- `--dry-run` (print planned actions only)
- `--no-push` (commit locally, skip push, still attempts release create if you continue)
- `--show-versions` (print local + latest remote version)
- `--suggest-version` (print next valid patch version)
- `--check-version` (validate ordering and exit)

## Version rules enforced by script

- New version must be greater than `src-tauri/tauri.conf.json` version
- New version must be greater than latest remote `v*` semver tag
- Tag must not already exist locally/remotely

## Common failure cases

- Dirty git tree -> commit/stash first.
- Not on target branch -> checkout target branch (usually `main`).
- Tag already exists -> choose a new version.
- `gh` unauthenticated -> run `gh auth login`.
- Missing CI secrets -> release workflow fails after release is created.
