# Remote access release gate

The gate uses a checksummed package archive, the actual owner HTTP routes, a long-lived service and the public controller boundary. It never uses a registry publish or real provider accounts.

Restore project dependencies with Node from `.nvmrc` and `npm ci --allow-git=root`, then build the workspace dependencies required by the reference server. Install the artifact after dependency restoration:

```sh
GOZAR_TARBALL=/path/to/package.tgz \
GOZAR_TARBALL_SHA256=<full-sha256> \
GOZAR_SOURCE_SHA=<full-source-revision> \
GOZAR_COVERAGE_MATRIX=/path/to/coverage-matrix.json \
PLAYWRIGHT_BROWSERS_PATH=/path/to/shared-browser-cache \
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/existing/chromium \
node scripts/reachability/run-release.mjs
```

The installer checks integrity before installing into an isolated dependency prefix. It does not change dependency manifests or lockfiles. It requires headroom above the 100 GB disk floor. The runner checks disk before each step, keeps every registered provider/usage pair in the matrix and fails on missing coverage. Browser steps require 110 GB free. They use the existing cache and never download a browser.

`testing-effects.mjs` is the only effects-harness seam. `effect-fixtures.ts` imports the published request/result unions. Its handlers match exact kind/operation pairs. Fixture outputs live in neutral fixture assets; network proof requests reach the actual owned local gate. Long-running spawn fixtures create harmless children and retain their own resource ledger. Credentials are transient and excluded from arguments, environment, diagnostics and browser responses.

`release-journey.test.mjs` exercises the real owner HTTP service. Separate suites cover draft rotation, locked custody, public recovery, runtime consent, pending initial streaming proof and installer refusals. `contract-preflight.test.mjs` checks export availability only. It cannot certify a lifecycle result.

Run browser journeys through `e2e/harness.mjs --reachability reachability.spec.ts` and `--reachability-stream reachability-stream.spec.ts`. They require the existing private network/PID namespace. A fixture run cannot certify external account entitlement or internet reachability.

The controller suites use the resource governor without a user namespace because this artifact rejects the namespace's unmapped root owner. The browser harness keeps its required isolation and therefore fails before launch on that artifact. A forced test-process exit handles the missing factory shutdown API only after public route cleanup attempts; retained cleanup uncertainty remains a failure.

Normal checks remain required: reference `PDPP_TEST_PROFILE=memory-default npm test`, console `npm test`, both packages' type checks and lint, and a console production build. See `BLOCKERS.md` for unresolved acceptance items. The production supervisor must supply identity, host capabilities, secret custody and listener/password policy through `createReachabilityService`; the Tauri keychain and supervisor bridges are follow-ons.
