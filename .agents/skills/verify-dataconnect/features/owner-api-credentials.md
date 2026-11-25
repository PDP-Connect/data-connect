# Owner API tokens and credentials

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 8. Owner API tokens and credentials

**Who starts:** Owner/operator. **Where:** `/deployment/tokens`; Overview link `owner tokens →`, `Manage →`, command palette `Issue owner token`, or Deployment subnav `Owner tokens`. **Code:** `apps/console/src/app/(console)/deployment/tokens/page.tsx:59-165,281-355,359-427,489-550`; `apps/console/src/app/(console)/deployment/tokens/actions.ts:37-80,82-125,128-200`; `apps/console/src/app/(console)/lib/operator-bootstrap.ts:113-210,213-315`; `apps/console/src/app/(console)/lib/owner-token.ts:1` (V).

1. Page heading is “Owner tokens” / “Owner credentials”. It recommends “Let the local agent complete onboarding” for a trusted local agent. Exact command: `pdpp owner-agent onboard '<public entrypoint>' --client-name 'local assistant'`. Copy says: “Use this for a trusted local agent. The agent starts from the public entrypoint, opens the browser approval flow, and writes the owner credential directly to its local state. No bearer needs to be pasted into chat or copied out of the dashboard.” The CLI stores the credential in its local agent state; an assistant can use top-level `access_token` for owner-level REST reads and must not send it to `/mcp`. **V** `apps/console/src/app/(console)/deployment/tokens/page.tsx:59-97`.
2. Manual fallback is labeled “Manual/debug bearer”. It is for debugging a controlled script or inspecting the wire flow. Enter `Debug credential name` (placeholder `e.g. local-debug`) and click `Issue debug bearer`. A blank name errors “Token name is required”. The form action does register a fresh public OAuth client per credential, then starts, approves, and exchanges the canonical device flow. **V** `apps/console/src/app/(console)/deployment/tokens/page.tsx:106-134`; `apps/console/src/app/(console)/deployment/tokens/actions.ts:56-80`; bootstrap `apps/console/src/app/(console)/lib/operator-bootstrap.ts:113-210`.
3. After success, the bearer appears in a one-time result on the flow URL with name, issue timestamp, code block and `Copy bearer token`. Copy says: “Manual bearer issued. Copy it now if you are debugging a local script — the dashboard does not store it. Send as Authorization: Bearer … to /v1/*.” The dashboard keeps this flow state in server memory, not durable storage; after flow state expires/process restarts the bearer is not retrievable from the page. **V** `apps/console/src/app/(console)/deployment/tokens/page.tsx:136-163`; `apps/console/src/app/(console)/lib/operator-bootstrap.ts:47-57`.
4. This is an owner bearer: it grants full owner REST read access to `/v1/*` (“reads everything”), for the signed-in owner, CLI/script they wrote, or trusted local agent. It is explicitly not for normal ChatGPT/Claude/Codex MCP setup; `/mcp` rejects owner bearers. MCP apps use `/connect` and receive grant-scoped tokens. **V** `apps/console/src/app/(console)/deployment/tokens/page.tsx:281-305`; `apps/console/src/app/(console)/connect/page.tsx:370-384`.
5. List rows show credential name, issue time (or “first issued” for multiple tokens), active-token count, client ID, rename field, and revoke. More than one active bearer reveals `Show individual tokens (N)`; each shows issue time, expiry or `no expiry`, a public token digest, and `Revoke this token`. The bearer itself is never listed again. **V** `apps/console/src/app/(console)/deployment/tokens/page.tsx:308-355,359-427,489-501`.
6. Rename updates only the display label; the action errors if client/name missing. Revoke this token revokes one bearer but leaves other tokens for that client. Credential-level revoke deletes its OAuth client and cascade-revokes all its bearers. Notices: “Token revoked. That one bearer no longer works; the credential’s other tokens are unaffected.” and “Credential revoked. Its bearers no longer work.” **V** `apps/console/src/app/(console)/deployment/tokens/actions.ts:128-200`; `apps/console/src/app/(console)/deployment/tokens/page.tsx:538-540`.
7. Owner onboarding CLI uses device authorization and can disclose the device-flow transcript (POST `/oauth/device_authorization`, `/device/approve`, `/oauth/token`). The page can `Introspect this token`, showing JSON and refresh time. Curl and `pdpp CLI` reproduce panels are available. `@pdpp/cli` is required on PATH for the CLI transcript/reference commands; `PDPP_OWNER_SESSION_COOKIE` is required when owner auth is enabled for CLI reads. **V** `apps/console/src/app/(console)/deployment/tokens/page.tsx:168-270`; trace CLI note `apps/console/src/app/(console)/audit/[traceId]/page.tsx:474-497`.
8. A CLI owner-device flow returns the verification URI `/device`, a six-character uppercase user code, and `expires_in` (300 seconds by default), or a complete link `/device?user_code=…`. The owner must be signed in. Without a valid code, the page says “Paste the code shown by the CLI to continue the owner sign-in flow.” under “Enter verification code”; field `User code`, button `Continue`. With a pending code, it says “A CLI is asking to sign in on your behalf. Approve only if you started this on a device you trust.” / “Approve owner access to <provider>”. Facts are `Client`, `User code`, and `Expires`, plus `Owner subject` and signed-in-owner label; when owner auth is disabled, it instead exposes `Subject ID` default `owner_local`. Choose `Approve and issue owner token` or `Deny`. Approval result: “Approved” / “CLI access approved” / “The CLI can return to polling and complete sign-in now.” Denial result: “Denied” / “CLI access denied” / “The CLI will stop polling and report that access was denied.” A malformed or expired GET code returns to the code-entry page with the code prefilled and no error message. A stale POST decision returns an OAuth error description from the server; if the owner session expired, it says “Sign in again to approve device access.” This route issues an owner token, not a grant-scoped MCP token. **V** `reference-implementation/server/routes/as-device-ui.ts:119-205,214-317`; `reference-implementation/server/auth.ts:11801-11865`; decision operation `reference-implementation/operations/as-device-decision/index.ts:68-119`.

**What the bearer can do:** The page says it grants full owner REST read access and “reads everything.” The bearer is owner-level, not read-only or source-scoped: the same owner-bearer guards authorize mutating REST actions such as manually running, scheduling, revoking, or deleting a connection. It is not accepted by `/mcp`; MCP apps use grants. **V** `apps/console/src/app/(console)/deployment/tokens/page.tsx:281-305`; `apps/console/src/app/(console)/connect/page.tsx:370-384`; `reference-implementation/server/routes/owner-connection-run.ts:426-433`; `reference-implementation/server/routes/owner-connection-schedule.ts:395-430`; `reference-implementation/server/routes/owner-connection-delete.ts:371-378`.

**Expiry:** Access token rows can show a concrete expiry or `no expiry`; the issuance form offers no expiry selector and does not display an expiry choice before minting. Device authorization’s `expires_in` is the short-lived approval code window, not the issued access token lifetime. Do not confuse the two. **V** `apps/console/src/app/(console)/lib/operator-bootstrap.ts:170-207`; `apps/console/src/app/(console)/deployment/tokens/page.tsx:326-343`.

**Terminology:** I found no separate “API token” or “Personal Access Token” creation screen. The product calls its owner-level API bearer an “Owner token” or “Manual/debug bearer.” A normal app’s token is obtained through the grant-scoped `/connect` OAuth flow. **V** token page and `/connect` copy cited above.

**Rough edges:** The UI uses “Owner tokens”, “Owner credentials”, and “Manual/debug bearer”, not “API token”. The page says full REST `/v1/*` access, but token expiration is only visible after there are multiple active tokens; it is not a field on the initial issuance result. The raw device `user_code` is stored in flow memory and shown in the protocol transcript, not a user-entered approval step for the composite one-click action. Per-token metadata lives in the auth server; the secret bearer is not recoverable. **V** cited code.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `owner-api-credentials`. **Combined isolated run:** `owner-api-credentials`: **pass**.

**What it verifies:** The capture opens the signed-in owner token page.

**Reaches:** The `/deployment/tokens` page renders with “Owner tokens”.

**Stops at:** It does not issue, copy, revoke, or use an owner bearer.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: owner-api-credentials"
```

**Evidence:** `evidence/owner-api-credentials/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

Owner bearer creation is separate from normal scoped MCP authorization. No credential is emitted by this journey.
