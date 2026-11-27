# Updating

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 7. Updating

**Who starts it:** person or release/deployment operator. **Where:** GitHub Releases, or provider’s deployment UI/CLI. **Forms:** desktop and server.

1. [V] Desktop learns from the GitHub Releases page, not an in-app updater. Installers are manual; root README explicitly says no in-app auto-updater. The updater artifacts are disabled in Tauri config. [README.md:8-18; src-tauri/tauri.conf.json:34-39]
2. [V] Install the new OS artifact. Local data is stored outside the app package; the downloaded browser cache in the user's data directory persists across updates. [README.md:84-96] Managed server DB/key locations vary by OS/data-directory configuration; no single “move data” prompt appears.
3. [V] Server update is by replacing image/source deployment. Docker stores DB, setup state, browser profiles, connector artifacts and credential encryption key in `pdpp_data`; Core updates require keeping the same volume. Railway/Fly use durable Postgres; deploy current or pinned image. [deploy/docker/README.md:224-230; deploy/flyio/README.md:79-83; deploy/railway/README.md:120-134]

Release pipeline gates automatic desktop releases on successful client and reference CI for the same main commit; sets Tauri version in build checkout; builds macOS, Windows and Linux artifacts plus Core images. [docs/release-process.md:3-24] Pages are built from the same branch/release source as Core image; attached desktop reads the server’s own console. A separately deployed console and server can be different versions in the documented manual/split Railway path; no compatibility banner or forced version match is found. [deploy/railway/README.md:11-14,68-71]

**Rough edges:** no app update notification or in-app “Check for updates” despite historical update plans/docs; self-host upgrades require operator knowledge; separate console/server versions can drift in manual split installs.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `settings`. **Combined isolated run:** `settings`: **pass**.

**What it verifies:** The capture reaches the installed-version information.

**Reaches:** The Settings page shows the current About version and build.

**Stops at:** It does not check a release, download an installer, replace a server image, or update a desktop app.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: settings"
```

**Evidence:** `evidence/settings/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

This branch has no ordinary in-app updater control. Release and deployment updates are external operations.
