# Navigation and reachability

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 13. Navigation and reachability

**Who starts:** Person. **Where:** sidebar, contextual subnav, topbar, logo, in-page links, or keyboard palette. **Code:** `apps/console/src/app/(console)/components/shell.tsx:50-78,127-199,380-395`; `reference-implementation/vendor/operator-ui/src/components/views/routes.ts:75-125`; `reference-implementation/vendor/operator-ui/src/components/command-registry.ts:70-264`; command palette cited above (V).

1. Main sidebar order in live mode: `Overview` `/`; `Explore` `/explore`; `Sources` `/sources`; `Audit` `/audit`; `Grants` `/grants`; `Syncs` `/syncs`; `Schedules` `/schedules`; `Connect apps` `/connect`; `Deployment` `/deployment`; `Device exporters` `/device-exporters`; `Event subscriptions` `/event-subscriptions`. It is one vertical group, no “Advanced” disclosure. **V** `apps/console/src/app/(console)/components/shell.tsx:50-78`.
2. Context subnav appears for Explore/Search: group label “Explore workspace”, links `Records feed` `/explore` and `Jump to artifact` `/search`. Grants subnav label “Grants workspace”: `Pending approvals` `/grants#pending-approvals`, `Packages` `/grants/packages`, `Grant request` `/grants/request`. Deployment subnav label “Deployment”: `Deployment overview` `/deployment`, `Connect apps` `/connect`, `Owner tokens` `/deployment/tokens`. **V** `apps/console/src/app/(console)/components/shell.tsx:161-199`.
3. Topbar controls include density, theme, `Jump to…` with `⌘K`; mobile has a menu drawer. Footer probes authorization/resource endpoints in live mode and shows URLs with copy controls. **V** `apps/console/src/app/(console)/components/shell.tsx:238-253,380-395`.
4. Jump palette has “Navigate” commands: `Overview`, `Explore`, `Jump`, `Audit`, `Grants`, `Syncs`, `Sources`, `Schedules`, `Deployment`, plus live-only `Notifications`, `Connect apps`, `Device exporters`, `Event subscriptions`. “Quick action” commands: `Pending approvals`, `Issue owner token`, `Grant request workspace`, `Failed audit events`, `Failed syncs`, `Record activity`, `Source inventory`. Search matches title, description, href, keywords. **V** `reference-implementation/vendor/operator-ui/src/components/command-registry.ts:70-264`.
5. Pages reached by contextual links rather than main nav include source detail/stream/record/health, Add source, source schedules, deployment provider apps/tokens, sync run/stream, trace/grant details, package details, pending approval detail, grant request, notifications, event subscription detail. In-page action links include add-source, schedule, run, audit, consent, CLI, and relationship links. **V** route tree and pages above.

**Routes without a primary sidebar entry:** `/settings`, `/consent`, `/grants/bootstrap`, `/stream-playground`, `/sources/stream-playground`, `/sources/deployment`, `/sources/schedules`, `/design-system`, `/grants/approvals/<approvalId>`, and `/syncs/<runId>/stream`. Some are linked from context; `/settings` is linked by `Developer mode` on Add data when connectors are hidden. The playground/design-system routes were not found in the live nav/command registry. `/consent` is reached only by the authorization redirect. The full branch route inventory is 45 page routes (see BASECHECK §C); this list describes route reachability rather than repeating the inventory. **V** tree and links.

**Sandbox:** The public `/sandbox` mirror has the common read-only nav but omits live-only Connect apps, Deployment, Device exporters, Event subscriptions, Notifications and owner-only grant actions. It shows “Sandbox demo — all data is fictional and deterministic. No owner credentials, no live AS/RS, no real records.” and has `Reference overview →`. **V** `apps/console/src/app/(console)/components/shell.tsx:64-77,267-305`.

**Rough edges:** The sidebar and palette contain different sets: notifications is only command-palette navigation; `Jump` in the palette goes to `/search` while free text goes to Explore. Contextual page URLs and development playgrounds are not discoverable in the main menu. **V** cited files.

### Things in the code that no page reaches

- `/design-system`, `/stream-playground`, and `/sources/stream-playground` are page routes with no normal user-navigation link found. **V** route tree; presentation pages.
- `/grants/bootstrap` is a route but was not found as a direct menu destination. The normal grant-request workspace is `/grants/request`. **V** route tree and registry.
- Individual grant revoke endpoint exists, but the UI exposes hosted-MCP package-level revoke; no page control for arbitrary per-child revoke was found. **V** grant/package page and action code.
- Owner bearer creation routes and `/deployment/tokens` are not ordinary MCP app setup; they are for owner REST tooling and trusted local agents. `/mcp` explicitly rejects owner bearers. **V** tokens and connect pages.
- No in-product route or button for bulk export/download of all collected data, and no individual record delete control, was found. Record-level blob links and the raw JSON disclosure are the available record export/open surfaces. **V** Explore/stream/inspector scan.

### What I did not check

- I did not open the app, server, public site, or private screenshots. I read the requested local branch only.
- I did not configure ChatGPT, Claude.ai, Claude Code, Codex, a webhook receiver, browser push permissions, or a provider account. Those product-side screens and account requirements are outside this repository.
- I did not execute API flows or verify server responses live. Error wording above is from branch code, not a live walk.
- I did not reproduce the BASECHECK first-launch, sources setup, or connection-status flows; BASECHECK already inventories those. I only included cross-links where they explain how collected data is reached.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `navigation`. **Combined isolated run:** `navigation`: **pass**.

**What it verifies:** The screenshot includes responsive navigation and its visible route links.

**Reaches:** The Overview route renders at desktop and phone widths.

**Stops at:** The journey does not click through every sidebar, contextual link, jump-palette command, or mobile drawer item.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: navigation"
```

**Evidence:** `evidence/navigation/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The route map is broader than this single navigation screenshot. Use the route baseline for page reachability.
