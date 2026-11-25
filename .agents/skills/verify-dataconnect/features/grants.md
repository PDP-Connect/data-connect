# See apps with access and revoke access

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 7. See apps with access and revoke access

**Who starts:** Person. **Where:** `/grants`; reached by sidebar `Grants`, Overview’s `all grants →`, or app grant/audit links. **Code:** `apps/console/src/app/(console)/grants/page.tsx:52-185,187-269`; `/grants/<id>` `apps/console/src/app/(console)/grants/[grantId]/page.tsx:26-94`; package routes `apps/console/src/app/(console)/grants/packages/page.tsx:1`, `apps/console/src/app/(console)/grants/packages/[packageId]/page.tsx:1`; shell `apps/console/src/app/(console)/components/shell.tsx:179-188` (V).

1. `/grants` shows pending approvals when there are any, then issued authorizations and lifecycle decisions. Header description: “Issued authorizations and lifecycle decisions for client access to owner data.” Empty state: “No grants yet”; hint: “Grants appear after a connected app requests access and the request is approved, denied, or fails.” **V** `apps/console/src/app/(console)/grants/page.tsx:111-159`.
2. Pending approvals show “Approval requests waiting for you.” Each row links to a detail review. A note says approval shortcuts are available only in local approval mode; otherwise “sign in through owner access and approve the request there.” `Deny` is available from pending row; approvals can also be reviewed through the detail route. **V** `apps/console/src/app/(console)/grants/page.tsx:115-135`; `apps/console/src/app/(console)/grants/pending-approval-row.tsx:1`; approval route and `apps/console/src/app/(console)/grants/approvals/[approvalId]/approval-review.tsx:1`.
3. Grant filters include query placeholder `id contains…` and status values `issued`, `revoked`, `denied`, `failed`, `pending`. Active chips label “state” and “query”. Rows display source/app identity, status, last event time, grant ID, `<N> events`, source, and optional `package <id> →`. Desktop row opens a peek; small screens open full `/grants/<id>`. **V** `apps/console/src/app/(console)/grants/page.tsx:139-178,187-269`.
4. Grant detail shows the event timeline, event count and revoked status, load-more timeline events, package link if any, and “Event subscriptions for this grant →”. Each timeline row has a collapsed `data` disclosure. Open the `grant.issued` event’s `data` to see raw issue-time scope evidence: access mode, purpose, retention, source, resolved stream names, selected fields, instance IDs, optional resource/time constraints, and the retained source-declaration snapshot. This is where a person can inspect which data that grant was approved to read; the page does not translate this JSON into a plain-language scope summary. It prints CLI `pdpp ref grant timeline <grantId>` and raw server URL. **V** `apps/console/src/app/(console)/grants/[grantId]/page.tsx:60-92`; shared `reference-implementation/vendor/operator-ui/src/components/timeline-view.tsx:126-169`; evidence built by server `reference-implementation/server/auth.ts:2029-2054,9293-9319`.
5. Packages page groups hosted-MCP approvals and explains “One package per hosted-MCP approval. Each wraps one or more source-bounded child grants and a single bearer-token lifecycle.” Package identity shows client, subject, status, and created/approved/revoked times. Each child row shows grant ID, grant/member status, added/revoked time, and source only; it does not show the child’s stream/field/date scope or expiry. Open the child grant to inspect its `grant.issued` event data as described above. If a package belongs to a multi-package lineage, `Cumulative client access` counts active child grants/packages but does not summarize their fields. Package detail has a confirmation checkbox: “Confirm revoke of package <id> and all N child grants.” The action revokes each active child; only after all succeed does it invalidate the package refresh token. Result says “Package revoked. Every child grant has been cascaded to revoked. The package’s MCP refresh token is invalidated.” **V** `apps/console/src/app/(console)/grants/packages/page.tsx:53-59`; `apps/console/src/app/(console)/grants/packages/[packageId]/page.tsx:129-205,248-256,270-320`; `apps/console/src/app/(console)/grants/packages/[packageId]/revoke-action.ts:38-64`; `apps/console/src/app/(console)/lib/ref-client.ts:3579-3598`.
6. Revoke one access from an individual grant detail/list is not universally provided. Package-level revoke is available for packages; individual grant lifecycle API exists, but the UI’s supported hosted-MCP revoke control is package cascade. `/grants/<id>` explicitly links to package where available. **V** package page/action and grant page.

**Revoke all:** No one-click “revoke every app” control was found. Revoke each credential on `/deployment/tokens`, each grant/package on Grants, and app identity separately as applicable. **V** inspected nav/pages/actions.

**Rough edges:** “Grant”, “package”, “child grant”, and lifecycle strings are protocol vocabulary. “Connected apps” is not a single all-purpose client list: grants and owner credentials live in separate sections with different access breadth. The grant list and package children show a source, but exact streams/fields/date bounds require opening `grant.issued` and reading raw JSON; package and grant pages do not show the grant’s expiry. Individual child grant revocation may exist at API level but the page deliberately exposes package cascade. **V** cited files.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `grants`. **Combined isolated run:** `grants`: **pass**.

**What it verifies:** The capture proves that the grant list route loads on a fresh server.

**Reaches:** The `/grants` page renders the “No grants yet” empty state.

**Stops at:** No app grant or pending approval exists, so the journey cannot inspect scope, detail, or revoke access.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: grants"
```

**Evidence:** `evidence/grants/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The empty state is not evidence of a grant approval or revoke action.
