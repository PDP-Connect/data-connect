# Product health (not connector health)

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 9. Product health (not connector health)

**Who starts it:** owner/operator looking for product/service readiness. **Where:** tray, Settings → Remote access, `/deployment`; `/sources/deployment` is adjacent but reports source-collection health. **Forms:** both; deployment diagnostics are server console.

1. [V] Tray row shows native lifecycle “Starting”, “Ready”, “Error”, or pairing/recovery state; menu “Show logs” opens the log file. [src-tauri/src/unified.rs:567-624,801-805]
2. [V] Remote access shows “Checking this computer…”, “Off”, current route status, “Unknown, possibly live”, stale/unreachable background-service state, and actionable route error cards. [apps/console/src/app/(console)/settings/remote-access-setting.tsx:121-128,1018-1044; apps/console/src/app/(console)/settings/route-display.ts:27-40]
3. [V] `/deployment` says “Operator diagnostics for the reference retrieval surfaces. Read-only. Secret environment values are redacted before reaching this page.” Its “Deployment readiness” panel says “Five checks that determine whether the deployment is ready to hand out as an MCP endpoint. Derived from the /_ref/deployment report rendered below.” It has these rows and next actions:
   - **Owner password gate.** “PDPP_OWNER_PASSWORD is set; owner surfaces require sign-in.” is ready. If missing: “PDPP_OWNER_PASSWORD is not set.” and hint “Set `PDPP_OWNER_PASSWORD` in your env and restart; otherwise `/owner`, `/device`, `/consent`, and `/` are reachable without auth.” Set the environment value and restart.
   - **Reference origin alignment.** Loopback needs no public origin. A mismatch says “PDPP_REFERENCE_ORIGIN=<configured>; you are viewing this dashboard from <observed>.” Hint: “Set PDPP_REFERENCE_ORIGIN to the browser origin and restart; the button copies the assignment.” Button “Use this origin” copies the assignment and changes to “Origin copied”.
   - **Storage backend.** Shows the database path and vector-index state: not configured (“No vector index configured yet.”), building, built, or stale. The source map cited `docs/operator/selfhost-quickstart.md:1` as a stale-index hint, but that file is absent from this checkout and current route code has no such link (`apps/console/src/app/(console)/components/deployment-readiness-rows.ts:1-293).
   - **Embedding cache.** Reports no backend, a cached/available model, disabled downloads, downloading, preparation not started, preparation failed, or unavailable status. Lexical retrieval remains ready in all these cases. When downloads fail it says “Restart Core to retry model preparation; this failure does not block lexical retrieval.” When preparation has not started it says “Core starts model preparation in the background; no semantic model is required for lexical retrieval.”
   - **MCP refresh-token advertisement.** It checks `/.well-known/oauth-authorization-server`; if unreachable, hint says to check `AS_ISSUER` and confirm `grant_types_supported` includes `refresh_token`. If absent, it says the reference image is too old and gives `docker compose pull` as the action.

   The overall banner is “Ready to share with Claude / ChatGPT”, “Attention needed before sharing”, “Not yet ready to share”, or “Some checks still running”, with a short explanation for each. Chips say “ready”, “attention”, “blocked”, “checking”, or “n/a”. The dashboard itself also links “Provider authorization” and “Tokens”. The same “Deployment readiness” link appears in the server-unreachable fallback, Connect apps, and an Audit trace detail; those pages link to `/deployment` rather than rendering the five-row panel. [apps/console/src/app/(console)/deployment/page.tsx:124-160; apps/console/src/app/(console)/components/deployment-readiness-panel.tsx:49-80,117-204; apps/console/src/app/(console)/components/deployment-readiness-rows.ts:94-293; apps/console/src/app/(console)/components/shell.tsx:414-420; apps/console/src/app/(console)/connect/page.tsx:307-313; apps/console/src/app/(console)/audit/[traceId]/page.tsx:115-120; apps/console/src/app/(console)/components/server-unreachable.tsx:23-29]

   `/deployment` also has a “Warnings” section, or “Warnings (<n>)” when nonempty. It renders a callout per server warning, with no action button; the server supplies each description. The callouts mean: “Embedding backend unavailable” — configure or restore the embedding backend; semantic retrieval is disabled. “Browser-backed connectors need a local collector” — enroll a local collector before running those connectors. “Semantic index is rebuilding” and “Lexical index is rebuilding” — wait; each search type may return partial results until the background rebuild ends. “Local collector protocol is outdated” — upgrade the paired collector; ingest is rejected until then. “Model download disabled” — enable downloads or provide a cached model for semantic retrieval, or accept lexical-only retrieval. “Embedding model cache missing” — follow the server's cache/preparation message. “Semantic index is stale” — it rebuilds at next startup or write. “Using blob-flat vector fallback” — no action is required for correctness, but large searches may be slower. “Zero semantic participation” — declare `query.search.semantic_fields` on a loaded stream. “Disk headroom is low” — reclaim storage as the warning directs. [reference-implementation/vendor/operator-ui/src/components/views/deployment-diagnostics-view.tsx:188-218; reference-implementation/server/deployment-diagnostics.ts:602-787]

   The low-disk warning is exact and actionable. Below 2 GiB, it says disk headroom is critically low and a restart or Docker build is very likely to fail with “No space left on device”; it says to run `docker builder prune` or `docker system prune` and inspect Docker volumes manually before removing any volume data. From 2 to 5 GiB it says disk headroom is low and suggests `docker system prune` before the next restart. The additional `diskHeadroomRows()` helper under `apps/console/src/app/(console)/components/deployment-readiness-rows.ts:1` has tests but no UI caller in this branch; its separate row copy is not displayed. [reference-implementation/server/deployment-diagnostics.ts:727-744; apps/console/src/app/(console)/components/deployment-readiness-rows.ts:295-368; apps/console/src/app/(console)/components/deployment-readiness-rows.test.ts:282-437]

4. [V] `/sources/deployment` redirects to `/deployment`; it does not render a separate panel. Source collection health remains on source list/detail pages and is a different health system from server readiness. [apps/console/src/app/(console)/sources/deployment/page.tsx:7; reference-implementation/runtime/rendered-verdict.ts:3134; reference-implementation/server/ref-control.ts:7127-7137]
5. [V] Server unreachable fallback says “Reference server unreachable”; “This dashboard could not reach its PDPP authorization/resource server at <url>. The reference server runs alongside this console in your deployment; the dashboard recovers as soon as it responds again.” It recommends “Confirm the PDPP service is running in your deployment (Docker, Railway, Fly, or your VPS).”; “Check the deployment logs for a startup error, then restart the PDPP service.”; “Deployment readiness”. [apps/console/src/app/(console)/components/server-unreachable.tsx:11-31]

**Rough edges:** Deployment is described as read-only diagnostics, not an overall “DataConnect health” screen. The server-unreachable page refers people to logs and restart with no embedded log viewer. Tray lifecycle and Deployment readiness are separate sources of product status.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `product-health`. **Combined isolated run:** `product-health`: **pass**.

**What it verifies:** The capture reaches deployment readiness checks on the disposable server.

**Reaches:** The `/deployment` page renders with its “Deployment” heading.

**Stops at:** It does not stop host processes, fill disks, break the database, or verify external reachability.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: product-health"
```

**Evidence:** `evidence/product-health/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The harness cannot induce host-level failures without changing the isolated stack beyond this task.
