# Desktop and npm releases

## Automatic desktop releases

A merge to `main` runs `client-tests.yml` (client typecheck and client/console tests). When that push run succeeds, `desktop-release.yml` checks out its exact SHA, confirms it is still the current `main` head, and computes a version. Pull-request, fork, failed and cancelled CI runs cannot publish. This is the desktop release gate; other independent CI workflows are not aggregated into it.

The version script reads all commit messages since the highest reachable, stable, published `vX.Y.Z` release that has all five desktop installers. Empty historical npm releases, drafts, prereleases and tags outside the selected history cannot become the baseline. It refuses to guess if no complete desktop release exists.

| Commit | Bump |
| --- | --- |
| `fix:` or `perf:` (with optional scope) | Patch |
| `feat:` (with optional scope) | Minor |
| Conventional header with `!`, or `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer | Major, including at `0.x` |
| `test:`, `docs:`, `ci:`, `chore:`, `style:`, `refactor:`, `build:`, `revert:` without a breaking marker | None |

The highest bump in the range wins. Merge commits are ignored unless their messages follow the convention; ordinary merge histories still include the component commits. With squash merges, the squash commit's title/body must preserve the release intent. An explicit breaking marker overrides an otherwise ignored type.

The coordinator reserves `vX.Y.Z` at the tested commit through the GitHub API and creates a draft release. It never changes an existing tag. Tag reservations are read from origin, so unrelated tags in a shared local checkout do not affect version selection. If a historical npm tag or abandoned draft already occupies the computed version, it advances the patch until it finds an unused version. A retry at the same SHA reuses its draft. Failed/cancelled drafts remain visible to maintainers; a later merge computes from the last published desktop release, so it includes changes from unfinished releases too.

The coordinator calls `release.yml` as a reusable workflow. That workflow still owns the four desktop build legs, five installer uploads, DMG attestations, Core multi-platform build, secret scans and digest-preserving publication. Automatic builds set `src-tauri/tauri.conf.json` to the selected tag version in each checkout before verifying the tag/commit/version identity. This is a build-time change: `main` receives no bot commit. `Cargo.toml`'s `0.1.0` is the crate version and root `package.json` is a private workspace; neither is the desktop product version. Tauri reads the product version from `tauri.conf.json`.

After desktop upload and Core publication/promotion succeed, the coordinator publishes the draft as a normal release with `--latest`. The Core image is `ghcr.io/pdp-connect/data-connect/core:<version>` for linux/amd64 and linux/arm64. Its existing serialized promoter moves `core:latest` only forward by SemVer. GitHub Latest and `core:latest` are separate pointers.

The `desktop-release-main` concurrency group cancels older builds when a newer successful current-head run arrives. A late old CI completion does not cancel the current build. GitHub retains at most one pending run; queued intermediate merges can be replaced. Every eventual release includes qualifying commits since the last complete desktop release.

## Read-only version plan

```bash
node scripts/desktop-release.mjs plan
# Inspect another locally available commit/ref:
node scripts/desktop-release.mjs plan <ref>
```

The default target is local `origin/main`. The command pins that ref to a SHA, prints the desktop baseline, commit count and selected version (or skip reason), and uses the same version and remote-tag collision rules as the coordinator. It reads Git history, origin's tags and the GitHub releases API. It does not fetch, write files, create tags/releases or trigger workflows. Use a checkout with current main history and release tags; check the printed SHA against GitHub before relying on the result. `GITHUB_REPOSITORY` defaults to `PDP-Connect/data-connect` for this command. The plan predicts version selection, not whether the CI gate has passed.

At the 2026-10-21 inspection, main `79ac35bfb1e4757b8e5ee4baaea1d8fe884ea66c` had baseline `v0.7.54`, 827 commits since it, and selected `v1.0.1`. Newer complete desktop releases through `v0.7.63` are prereleases and remain excluded. Published Apple Silicon installer names use `_aarch64.dmg`; the script accepts that and `_arm64.dmg`. Historical breaking commits select `1.0.0`, and the existing remote `v1.0.0` tag advances the selection to `1.0.1`.

Before enabling automation, the owner should decide whether that major version is intended. To start at a chosen version instead, add a reviewed bootstrap record with the exact history cutoff SHA and first version (for example `0.7.64`, after checking availability). Both plan and prepare should consume that record until the first complete automated release is published, then use the ordinary release baseline. This is a proposed follow-up; no version override or historical-baseline change is enabled here.

## npm publishing

`npm-release.yml` continues to publish `@pdpp/connector-protocol`, `@pdpp/collector-runtime` and `@pdpp/local-collector` in lockstep, with the existing scope rules, quality checks, OIDC trusted publishing, dependency pin and registry/provenance verification. Its tags are now `npm-vX.Y.Z`. The GitHub release plugin is removed, so npm no longer creates empty releases or competes for Latest. Desktop uses `v*` from this change onward; historical tags and releases remain untouched.

On the first npm run with no reachable `npm-v*` tag, `npm-release-tags.mjs` reads the three registry `latest` versions, chooses the highest (including partial lockstep publication), requires a reachable legacy `v<version>` tag, and creates the matching `npm-v<version>` alias at the same commit. It fetches the alias before semantic-release computes the next version. Subsequent runs skip migration. Unknown registry state or a missing legacy tag fails rather than restarting npm at 1.0.0. The npm workflow's existing serialization protects migration against another npm run.

## Manual runs and recovery

Re-run the failed automatic workflow in Actions, or dispatch `desktop-release.yml` on `main`. Dispatch requires a successful `client-tests` push run for the exact commit too. A draft at that SHA can be rebuilt and published without moving its tag. A newer main head supersedes old automatic work; dispatch releases the current head only.

Existing manual commands remain available:

```bash
npm run release:github -- --version <version> --dry-run
npm run release:github -- --version <version>
npm run release:versions
npm run release:github -- --version <version> --check-version
```

`release:github` requires a clean target branch (default `main`), bumps and commits `tauri.conf.json`, pushes it, and creates the release. Human-created releases still trigger `release.yml` through `release: created`. Unlike the automatic path, that manual command publishes the release before assets finish. Manual release and automatic release creation should not run concurrently; they can reserve the same version.

The original desktop dispatch modes remain:

```bash
# Build a ref without publishing a release
gh workflow run release.yml -f ref=<ref>
# Install an existing release on fresh macOS/Windows VMs, without building
gh workflow run release.yml -f release_tag=vX.Y.Z
# Force the existing npm release path (reason required)
gh workflow run npm-release.yml -f release_type=patch -f reason='<reason>'
```

A manual published prerelease builds desktop and its versioned Core image but does not promote `core:latest`. Draft release creation does not start a release-event build. The automatic path explicitly calls the reusable workflow, so it does not depend on events produced with `GITHUB_TOKEN` triggering another workflow.

## Repository settings and first-run checks

- Actions must be enabled, including reusable workflows and the pinned actions. Allow `GITHUB_TOKEN` the job-requested `contents: write`, `actions: read`, `packages: write`, `id-token: write` and `attestations: write` permissions. The coordinator needs no PAT or new secret. Existing builders use `GITHUB_TOKEN`; macOS installers remain unsigned and notarization remains downstream.
- Tag rulesets/protection must permit the Actions identity to create `v*` and `npm-v*` tags. Branch protection on `main` needs no bypass: automatic releases never push commits to it. Protect workflow edits with the repository's normal review policy because `workflow_run` jobs have write privileges.
- GHCR must permit this repository's Actions token to publish the existing Core package. Retain npm trusted-publisher bindings for all three packages to `npm-release.yml` on GitHub-hosted runners. No `NPM_TOKEN` is added.
- Before enabling, inspect the last complete desktop release and its reachable tag. The first automatic run can contain many historical conventional commits and therefore produce a major bump. Missing old installer assets cause a closed failure or selection of an older complete baseline. Check the run's printed baseline/version and the npm migration's legacy tag.
- Cancellation can leave reserved tags, drafts, uploaded installers or a versioned Core image; those are retained and never silently deleted. Core promotion occurs before draft publication, so cancellation in that short window can leave `core:latest` ahead of GitHub Latest. Retry the same SHA. Automatic DMG attestations originate from the main workflow context rather than a release-event tag context; downstream signer policies must allow the reusable workflow through this coordinator. Hosted installers, GHCR, npm and signer integration must be verified in the first live run.

## Prior art used

[release-please](https://github.com/googleapis/release-please) parses conventional commits and maintains release PRs. Its additional merge step does not meet the request to release each qualifying main merge. [semantic-release](https://semantic-release.org/usage/configuration/) directly automates release versions and supports separate tag formats; npm keeps that established implementation here. [tauri-action](https://github.com/tauri-apps/tauri-action) supports branch-triggered native builds and draft releases. This implementation uses that branch-driven pattern after CI, retaining this repository's existing bundle finalization and publication checks instead of adding a second Tauri build matrix.

Local validation: `node --test scripts/desktop-release.test.mjs scripts/npm-release-tags.test.mjs` and `actionlint -shellcheck=''` on the changed workflows. The new tests also run in client CI.
