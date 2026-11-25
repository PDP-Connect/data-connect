# Connect apps and AI assistants

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 4. Connect apps and AI assistants

**Who starts:** Person pastes a URL into ChatGPT/Claude.ai or copies a command into Claude Code/Codex; a third-party client can also start OAuth. **Where:** `/connect` (`Connect apps`) and public `${origin}/llms.txt`; endpoint `${origin}/mcp`. **Code:** `apps/console/src/app/(console)/connect/page.tsx:37-53,91-99,101-175,234-385`; `apps/console/src/app/(console)/connect/actions.ts:1`; `reference-implementation/server/routes/as-authorize.ts:1`; `reference-implementation/README.md:132` (V).

1. On `/connect`, heading is “Connect apps”; description: “Give apps and local clients grant-scoped read access to data already in this instance. To add or manage data sources, go to Sources.” The primary rows are MCP URL, Claude Code command, and Codex command. The explanatory copy says: “Use this for ChatGPT, Claude.ai, and remote MCP clients. Browser clients use PKCE; some clients use the device-code flow.” **V** `apps/console/src/app/(console)/connect/page.tsx:276-345`.
2. The console copies the public origin plus `/mcp` as “MCP server URL”. It generates `claude mcp add --transport http pdpp <origin>/mcp` and `codex mcp add pdpp --url <origin>/mcp`. The copy says the Codex command “Adds the same remote MCP endpoint without a separate bearer token.” The page also provides `<origin>/llms.txt` as “Instructions URL” for clients that read public instructions before choosing MCP or CLI. **V** `apps/console/src/app/(console)/connect/page.tsx:37-45,276-303`.
3. In ChatGPT or Claude.ai, the person pastes the MCP server URL into that product’s connector/custom MCP setup. The app starts OAuth and the person signs in to this instance. The approval route depends on the request: with neither `authorization_details` nor `connector_id`, the server creates an opaque consent challenge and redirects to console `/consent?challenge=…`; with either field, it starts the request-URI flow and redirects to server-hosted consent. See flows 5 and 6. Browser clients use PKCE; some clients use device code. The repository does not provide ChatGPT/Claude.ai setup-screen instructions. **V** `reference-implementation/server/routes/as-authorize.ts:1534-1632`; other-side UI is not in this repo.
4. In Claude Code or Codex, the person runs the copied command in that tool’s terminal/configuration. The tool performs OAuth and the person approves on this instance. These coding clients need a public HTTPS origin reachable by the remote client; commands point to the configured reference public origin. Deployment page links from `/connect` as “Deployment readiness”. **V** `apps/console/src/app/(console)/connect/page.tsx:37-45,307-315`; origin from `getReferencePublicOrigin()` at `:255-260`.
5. Optional stable local client identity: fill `Client name` (default `Claude Code`) and `Redirect URI` (default `http://localhost:1455/callback`, placeholder `http://localhost:<port>/callback`), then `Create identity`. Select a saved identity with `Use`; the page provides default and `CIMD` commands. The explicit Claude command is `claude mcp add --transport http --client-id <client_id> pdpp <mcp_url>`; Codex is `codex mcp add pdpp --url <mcp_url> --oauth-resource <mcp_url> --oauth-client-id <client_id>`. Its copy says the redirect URI must exactly match the local client callback. `Revoke` deletes that metadata URL and revokes issued access. **V** `apps/console/src/app/(console)/connect/page.tsx:48-53,101-175,178-231,348-357`; actions file.
6. “Owner credentials stay out of ordinary MCP setup.” The page says ordinary Claude, ChatGPT, Codex, Claude Code, and other MCP clients use scoped OAuth at `/mcp`; this returns a scoped client token, never the owner bearer. Owner credentials are for the owner/trusted local tools only. **V** `apps/console/src/app/(console)/connect/page.tsx:370-384`.

**Needs already true:** Data exists and at least one source is connected. The instance must have a public URL accessible by the outside app. TLS and OAuth/authorization endpoints must work. The repo does not show third-party product setup, account-plan restrictions, or successful external pairing. **V/I** `apps/console/src/app/(console)/connect/page.tsx:1`; external steps I because consumer screens are outside the repository.

**Rough edges:** `/llms.txt` and public OAuth discovery can be copied, but external product instructions are not shown. The page does not say in a checklist that the configured public origin must be externally reachable. `CIMD` and `URL-shaped client_id` are protocol vocabulary. Stable identity is optional and not needed by default. The copy says some clients use device-code flow, but does not direct the person to the `/device` owner sign-in page; that page says `Approve and issue owner token`, which grants broader owner access than the grant-scoped `/mcp` flow. **V** `apps/console/src/app/(console)/connect/page.tsx:276-345,348-361`; device page `reference-implementation/server/routes/as-device-ui.ts:179-196`.

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `connect-an-mcp-client`. **Combined isolated run:** `connect-an-mcp-client`: **pass**.

**What it verifies:** The capture reaches the setup instructions and MCP connection page.

**Reaches:** The `/connect` page renders with “Connect apps” at desktop and phone widths.

**Stops at:** No outside assistant or MCP client is installed or authorized in the sandbox.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: connect-an-mcp-client"
```

**Evidence:** `evidence/connect-an-mcp-client/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The journey verifies the server-side instructions. It does not verify a third-party client account or connection.
