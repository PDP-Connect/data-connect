# Install/update/remove connector package and connector packs

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 9. Install/update/remove connector package and connector packs

**Who starts:** Person. **Where:** `/sources/add`, “Package” column/card. The owner’s described upgrade path is exact: open “Add source” → find/search the existing connector by display name/key → read Package row (“Update available”, installed version, target version) → click “Update”. It does not begin from the source’s settings. **Both forms**, only where owner connector-install API is available. V — `apps/console/src/app/(console)/sources/add/page.tsx:45-87`; `apps/console/src/app/(console)/components/source-setup-catalog.tsx:509-565`; `apps/console/src/app/(console)/sources/add/connector-install-row.tsx:22-71`.

1. Package state strings: “Included”, “Not available in this app”, “Not installed”, “Active”, “Update available”; additional version text “Installed v…”, “Update to v…”, “Available v…”. Package details can show “Installed digest …” and “Target v…”. V — `apps/console/src/app/(console)/lib/connector-install-presentation.ts:186-227`; `apps/console/src/app/(console)/sources/add/connector-install-row.tsx:80-108`.
2. Not installed action “Install”; while running “Installing…”; success “Install complete. Refreshing status…”. Update: “Update” → “Updating…” → “Update complete. Refreshing status…”. Action submits an owner server action to install/update by connector id/digest, then refreshes page. V — `apps/console/src/app/(console)/sources/add/connector-install-row.tsx:30-50,66-70`; `apps/console/src/app/(console)/sources/add/connector-install-actions.ts:1`; server install route called by connector-install-client.
3. If package is in use, no? Uninstall button appears when package installed and requires browser `window.confirm`: `Uninstall <connectorId>? This is allowed only when no sources use it.` Success “Uninstall complete. Refreshing status…”. Failure is returned inline. V — `apps/console/src/app/(console)/sources/add/connector-install-row.tsx:52-64,115-130`; action `apps/console/src/app/(console)/sources/add/connector-install-actions.ts:1`.
4. If catalog is transiently busy, notice says “The package catalog is refreshing. This page will retry once in a few seconds; use Retry now if package actions still do not appear.” Retry states “Checking the package catalog now…”, “The package catalog is still busy. Use Retry…” Button “Retry”. Packages unreadable count: “N package offers could not be read and are not listed. Check the service logs.” V — `apps/console/src/app/(console)/components/source-setup-catalog.tsx:406-439,684-693`.
5. Registered package can show “Registration pending. Account setup appears once the server registers this connector.” Some sources/packages are on OCI signed artifacts; “connector packs” are not exposed as a pack-install chooser in this page. It presents package entries per connector. The source branch has install catalog and artifact/update implementation but no person-facing pack collection workflow located. V — `apps/console/src/app/(console)/components/source-setup-catalog.tsx:550-553`; install UI above; server package catalog API path in connector install client/actions.

**Rough edges:** (1) required update path is under Add source; (2) uninstall uses native browser `confirm`, not an in-page explanation; (3) errors can be raw server text; (4) packs are not represented as a person-facing pack concept on these pages.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `add-data-source`. **Combined isolated run:** `add-data-source`: **fail**.

**What it verifies:** The capture reaches the loading page before the catalog lookup fails.

**Reaches:** The journey opens the Add source route but cannot load its package catalog.

**Stops at:** It cannot inspect package rows or install, update, or remove an artifact because the GHCR catalog request is blocked.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: add-data-source"
```

**Evidence:** `evidence/add-data-source/<run-id>/` contains desktop and phone screenshots plus visible text. The failed Add source readiness assertion is also recorded in the Playwright trace.

## Gotchas

This result is a catalog failure, not a package-install test. The expected external registry is unavailable under `--net none`.
