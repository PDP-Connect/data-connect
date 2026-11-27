# Choose and add a source

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 1. Choose and add a source

**Who starts:** The person. **Where:** `/sources` → “Add source”; Add source header links back through “Overview” and “Sources”. The page says: “Add sources that populate this PDPP instance. App and local-client access is configured separately under Connect apps.” **Both forms.** Viewing the catalog needs no provider account. V — `apps/console/src/app/(console)/sources/page.tsx:84-100`; `apps/console/src/app/(console)/sources/add/page.tsx:31-45`.

1. The person sees “Add source” and an “Add data” section: “Choose a connector to add data. Supported is the default; exception labels explain preview, in-development, and setup limits.” The search field says “Search source name or connector key”; button “Search”. Cards are sorted by setup rank then display name. Preview and development are row labels, not separate sections. “Developer mode” in `/settings` controls development visibility. If no result: “No connector matched [query]. Try the source name or connector key.” V — `apps/console/src/app/(console)/components/source-setup-catalog.tsx:60-79,639-742`; `apps/console/src/app/(console)/lib/source-setup-presentation.ts:146-182`.
2. Each card shows the manifest/server display name, support label if applicable, one setup description, existing account links, optional setup help, and a separate “Package” state. “Existing accounts” can show a count/last-import fact and “Open in Explore” / “Source details”. Manual import cards can disclose “Show import options”; other cards may show “Provider documentation”. The detail text and field names are manifest-provided, not fixed across connectors. V — `apps/console/src/app/(console)/components/source-setup-catalog.tsx:218-320,453-567`.
3. Setup methods and their catalog copy are selected by disposition. They include: local collector (`Run the local collector on the machine that has this data.`), provider authorization (`Authorize this account through the provider.`), static credential (`Enter the provider credential for this account.`), browser sign-in (“Connect account from a secure browser session.”), file import (“Owner-exported file import.”), plus blocked/pending/unsupported entries. File cards expose acquisition paths using “Ways to add data”, “Other ways to add data”, labels/details/platform and “Open source instructions”. Provider cards can show the explanation “Credentials stay with the provider.” Static-secret and browser-bound pages accept generated manifest fields; key/token vs username/password is connector-defined. V — `apps/console/src/app/(console)/components/source-setup-catalog.tsx:153-189,91-140`; `apps/console/src/app/(console)/lib/source-setup-presentation.ts:61-72,218-340`.
4. The available primary actions are disposition-specific and may be “Add account”, “Connect account”, “Import file”, or an enrollment action; package state can instead show “Install package first” or “Registration pending. Account setup appears once the server registers this connector.” Entries with no current setup path appear under a collapsed disclosure: “N connectors cannot be added here”. They retain a reason label such as “Not available here”, “Server setup required”, “Browser setup not available yet”, or “Import not available yet”. A deployment-blocked provider entry can require environment variables and restart the server. V — `apps/console/src/app/(console)/lib/source-setup-presentation.ts:264-340`; `apps/console/src/app/(console)/components/source-setup-catalog.tsx:516-565,718-734`.
5. Provider authorization is a different path: `/connect/provider-auth/<connectorId>` says “Authorize [name]”; “Authorize this account in the provider's browser. The connection activates after authorization and account inventory succeed.” It says “Credentials stay with the provider. DataConnect activates the source after the provider confirms access.” The person clicks “Authorize account”; POST `/connect/provider-auth/<connectorId>/start` starts the server-managed OAuth redirect. Server app settings may be a prerequisite. V — `apps/console/src/app/(console)/connect/provider-auth/[connectorId]/page.tsx:23-79`, `apps/console/src/app/(console)/connect/provider-auth/[connectorId]/start/route.ts:1` (route); I — provider owns the actual approval screen and its text.
6. Static-secret forms are `/connect/static-secret/<connectorId>` and use the provider manifest’s field contract. New setup says “Add [name]” and “Enter the provider credential to create this connection and start its first sync. The account keeps its own connection identity and credentials.” It includes a connection label and provider-defined fields (password/token/key/user fields vary). If storage readiness is missing, the page shows “Credential storage is not ready” and lists `Set <environment key>`. Submission captures a credential and starts verification/first sync. Replace-credential mode says “Reconnect [name]” and “Records, history, and schedule stay attached to the same connection.” V — `apps/console/src/app/(console)/connect/static-secret/[connectorId]/page.tsx:48-68,133-197,199-259`; server actions — `apps/console/src/app/(console)/connect/static-secret/[connectorId]/actions.ts:1`.

**Import path:** `/connect/manual-upload/<connectorId>` says “Import [name]” (or “Import another [name] file”), “Pick a supported export file. DataConnect validates it, imports it, and gives you a coverage receipt you can revisit.” The supported extensions, source export instructions, accepted files and optional large-file fallback come from setup metadata. It says “This is a file import” and “You are importing data you already exported. There is no provider account sign-in and no deployment change.” File selection/upload is followed by parsing, deduplication and commit; errors return to the page as an inline message. V — `apps/console/src/app/(console)/connect/manual-upload/[connectorId]/page.tsx:113-183`, `apps/console/src/app/(console)/connect/manual-upload/[connectorId]/manual-upload-form.tsx:1`; server submit in `apps/console/src/app/(console)/connect/actions.ts:1`.

**Source name / multi-account behavior:** A label is optional on browser and static-secret create paths. The same connector can have multiple connections; each has its own connection identity/credential. Existing accounts are surfaced on Add source and can be selected for another import. Do not treat a package/card as an account. V — `apps/console/src/app/(console)/connect/browser-session/[connectorId]/page.tsx:193-239`; `apps/console/src/app/(console)/connect/static-secret/[connectorId]/page.tsx:63-101`; `apps/console/src/app/(console)/components/source-setup-catalog.tsx:218-269`.

**Rough edges:** (1) full offered names are instance/runtime dependent, not a fixed catalog in this branch; (2) package lock names and card display names can differ (ChatGPT and GitHub each have two artifacts); (3) connection methods and “what will be collected” are manifest-driven, so the branch alone cannot provide a single literal list of field labels/scopes for every live instance; (4) installable packages can be listed before account setup exists; (5) some entries are visible but dead-end without instance operator changes or a runbook. Locations above.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `add-data-source`. **Combined isolated run:** `add-data-source`: **fail**.

**What it verifies:** The first ready check times out because the isolated catalog request is refused when it tries to fetch `ghcr.io/pdp-connect/connector-catalog:latest`.

**Reaches:** The journey reaches `/sources/add`; the Add source catalog stays at “Loading Sources…” and never reaches the Spotify setup card.

**Stops at:** The baseline captures the stuck catalog route at desktop and phone widths. The journey trace records the failed readiness check. Do not claim that adding or connecting a source passed.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: add-data-source"
```

**Evidence:** `evidence/add-data-source/<run-id>/` contains desktop and phone screenshots plus visible text. The failed Add source readiness assertion is also recorded in the Playwright trace.

## Gotchas

The seed fixture can create records, but its provider catalog is separate from the source manifests. Offline GHCR access is intentionally blocked by this harness.
