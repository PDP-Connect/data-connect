---
name: verify-dataconnect
description: Verify the DataConnect web console with its disposable reference server, browser journeys, screenshots, and visible-text evidence. Use when checking a console feature or capturing a newcomer walk.
---

# Verify DataConnect

This skill drives the HTTP console and reference server from a fresh harness data folder. It does not cover the Tauri desktop shell. The desktop shell can reach the real operating-system keyring; a display alone does not isolate that storage.

## Launch

Choose a disk-backed folder for scratch data, logs, and evidence. Set `VERIFY_DIR` to that folder before running commands. From the repository root, run every declared journey and the route baseline in one invocation. This launches one disposable stack, builds the console once, captures the journeys, saves evidence, and tears the stack down:

```sh
VERIFY_DIR=/path/to/a/disk-backed/verify-run
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output"
```

The harness makes a production build of `apps/console`, starts a fresh reference server and console on random loopback ports, and makes a fresh SQLite database and random owner password. Do not set `E2E_BASE_URL`, `E2E_DATA_DIR`, `E2E_OWNER_PASSWORD`, `E2E_REMOTE_BASE_URL`, or `E2E_BUFFERING_BASE_URL`. The harness rejects them.

The harness builds on every run. The latest combined run built the console in 38.01 seconds and ran 26 Playwright tests in about 2.9 minutes; 25 passed and the Add source journey failed when its offline GHCR catalog request stayed unavailable. The E2E README reports a 27–90 second build range. The console build writes `apps/console/.next`; only one harness run can use this checkout at a time.

The specified `--scratch` directory is on disk under `$VERIFY_DIR`. `test-sandbox` sets `TEST_TMPDIR` to this path. The harness removes its owned `dataconnect-e2e-*` child when it exits. The empty parent directory may be reused. This keeps the harness's required network and PID isolation while avoiding its default private `/tmp` work directory.

The app is usable when the log shows `Reference startup` and `Console startup`, and the doctor step signs in with the generated owner password and renders the live Sources page. `next start` prints a standalone-output warning in this checkout; it still served the production build in the proving run.

## Doctor

The doctor check reads the disposable instance's ownership marker and process list, signs in to validate owner auth, and verifies that the live Sources page renders. It changes no feature data:

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs doctor.spec.ts --output "$VERIFY_DIR/playwright-output"
```

Every capture journey calls the same doctor before it seeds data or drives a feature. This harness is one-shot; a separate doctor invocation starts another fresh stack. The app has no build-SHA endpoint, so the build identity is the checkout passed to this harness command.

## Drive

The capture driver reads ordered JSON journeys from `e2e/journeys/`. A step opens a URL path or performs a role/name click, waits for visible text or a heading, then captures the page. Desktop-only and phone-only actions let a journey follow the responsive control that a person sees at that width. The all-journey command above omits `--grep`. For a focused run, select one journey by its test title:

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: sources-list-and-detail"
```

For fixture data, the capture logs in through the owner screen, requests a device code through the console, approves it in the browser, and passes the resulting short-lived owner token to `e2e/seed-fixture.mjs`. That helper uses the real seed connector and `runConnector` runtime against the same `PDPP_DB_PATH` as the harness server. It requires a successful run and at least one emitted record. It does not call the CLI `pdpp seed`; that command's automatic `/device/approve` call has no owner-session cookie or CSRF token, while the server requires both.

Use the page the way a person does. Open navigation links and click the visible list row. Do not call server actions directly, write rows into SQLite, or use test-only endpoints to create product state. Seed connector records are fictional fixture data; do not use a real company login.

## Evidence

Evidence is written to `$VERIFY_DIR/evidence`, beside the harness scratch, so cleanup cannot remove it. Journey evidence uses `evidence/<journey-id>/<timestamp>/`. Each route baseline uses `evidence/baseline-<local-date>/`.

Each journey run gets its own timestamped directory.

For each step, the driver saves a full-page desktop PNG, a full-page phone PNG, and the body text in DOM reading order for each viewport. `visible-text.txt` is updated after every captured step, so a failed assertion still leaves the screens and text that led to the failure. `capture.json` records the journey, run id, base origin, viewport sizes, and artifact names. The capture does not call a model. A later newcomer walk can give the PNGs and text to a model that has not seen DataConnect and ask what each screen means.

A proof must show the action and its result. Check the visible state and relevant side effect: the capture journey asserts that Spotify appears in Sources, opens its detail surface at both desktop and phone widths, and the seeder confirms emitted fixture records before navigation. Screenshots alone do not prove the data was written.

## Cleanup

The harness owns and stops its reference, console, build, and Playwright process groups. It removes its fresh data folder on success, failure, timeout, SIGINT, and SIGTERM. `test-sandbox --pidns` reaps detached browser descendants. The `--output` option keeps Playwright failure traces in the disk-backed `verify-run` directory. Do not kill processes by name.

Evidence survives cleanup under `$VERIFY_DIR/evidence`. To remove only the empty disk-backed sandbox parent after a run, use:

```sh
rmdir "$VERIFY_DIR/sandbox-scratch"
```

Keep the `evidence` directory. Do not run two harnesses in this checkout at once.

## Helpers

The executable doctor and capture commands are the `doctor.spec.ts` and `capture.spec.ts` invocations above. To run a different declared journey, set `--grep` to `journey: ` followed by the JSON journey's `id`. Journeys are ordered lists in `e2e/journeys/`; the feature map explains how to add them. The driver captures only. It does not ask a model to interpret the screens.

For fixture data, the capture driver runs `node --import tsx e2e/seed-fixture.mjs spotify` (or `github` or `reddit`) with the fresh harness URLs, database path, and owner token in its child environment. Do not run that command by hand; those values exist only inside the isolated capture run.

The connector catalog fetches its signed contents from `ghcr.io` on each request. Network isolation blocks that request, so `/sources/add` cannot show the live catalog in this harness. Demo routes for Home, Sources, source detail, Add source, Explore, and Grants need a non-production Next runtime: `/?demo=calm|alarm|decide`, `/sources?demo=mixed|healthy|attention`, `/sources/[connector]?demo=atlas`, `/sources/add?demo=atlas`, `/explore?demo=atlas`, and `/grants?demo=atlas`. Those page gates require `NODE_ENV !== "production"`, while the harness uses `next build` and `next start`. Syncs is an exception: `/syncs?demo=1` takes the demo branch without a `NODE_ENV` check, so it can be captured by this production harness if declared as a journey. The E2E README rejects `next dev` for its specs because its HMR websocket can reload the router during a relay test. The repo has no separate isolated capture command for the other demo routes today. Do not infer that their demo-only states were verified by a production screenshot. The feature map records these limits.

For a larger map of product flows, follow the conventions in `features/README.md`. Use `/maintain-verification-skill` when the map needs maintenance.
