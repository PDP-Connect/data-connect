# CLI commands and places that tell a person to run one

## Sub-features

This feature is the complete user flow below. The source map's steps, branches, exact visible copy, product forms, and repo-relative code references are retained here.

## How to get to it (user POV)

### 12. CLI commands and places that tell a person to run one

**Who starts it:** person or AI client. **Where:** terminal, `/connect`, page copy controls, docs. **Forms:** server CLI and local collector.

1. [V] There are two help surfaces. The published `@pdpp/cli` help (also available through the console’s `npx -y @pdpp/cli ...` form) exposes `package-info`, `connect`, `token`, `read`, `owner-agent`, `collector`, and `ref`. `read` has `schema`, `streams`, `query-records`, `fetch`, `field-window`, `search`, and `aggregate`. `collector` has `setup`, `run`, `connectors`, `logout`, `advertise`, and `enroll`. `owner-agent` has `onboard`, `status`, `control`, `connectors search/explain`, `setup`, and `revoke`. `ref` has `login`, `call`, `run timeline`, `grant timeline`, `trace show`, `connectors list/show`, and `event-subscriptions list/show/disable`. [reference-implementation/vendor/cli/src/index.ts:22-67,87-188; reference-implementation/vendor/cli/src/read/commands.ts:13-21; reference-implementation/vendor/cli/src/collector/commands.ts:25-33; reference-implementation/vendor/cli/src/owner-agent/command.ts:91-117]
2. [V] The reference-implementation wrapper at `reference-implementation/cli/index.ts:1` has a separate help screen. It advertises `auth login/introspect`, `provider show/register`, `owner streams/query|records/get/export`, `query streams/records/get`, `run timeline`, `grant start/revoke/timeline`, `trace show`, `inspect`, `seed`, and `agent bootstrap/status/request/wait/store/use/forget/revoke`; it delegates selected commands to `@pdpp/cli`. Reference-only commands need a running server and owner access. A direct `pdpp` command requires an install or an `npx` form. [reference-implementation/cli/index.ts:16-73,99-144; reference-implementation/cli/commands/agent.ts:49-143]
3. [V] Console `/connect` gives MCP endpoint/client instructions, including Claude Code/Codex command forms and no-install `npx -y @pdpp/cli ...`. [apps/console/src/app/(console)/connect/page.tsx:42-51]
4. [V] Other console command surfaces are Settings diagnostics (“Run this command, then try again:” with “Copy command” / “Try again”), Deployment → Tokens (`pdpp owner-agent onboard`), Syncs/Grants/Audit run or detail copy panels, source connection diagnostics, and local-device exporter enrollment (`pdpp collector enroll`). [apps/console/src/app/(console)/settings/diagnostics.tsx:109-169; apps/console/src/app/(console)/deployment/tokens/page.tsx:55-65,238-250; apps/console/src/app/(console)/syncs/[runId]/page.tsx:282; apps/console/src/app/(console)/grants/[grantId]/page.tsx:81; apps/console/src/app/(console)/audit/[traceId]/page.tsx:312; apps/console/src/app/(console)/sources/[connector]/connection-diagnostics.tsx:1210; apps/console/src/app/(console)/device-exporters/reenroll-button.tsx:16]
5. [V] Local collector docs describe installing/updating `@pdpp/local-collector`, then using `advertise`, `enroll`/`setup`, `run`, `connectors`, and `logout`; examples include `npx -y @pdpp/local-collector ...`. [packages/local-collector/README.md:48-128; reference-implementation/vendor/cli/src/collector/commands.ts:25-33]
6. [V] `apps/console/src/app/(console)/components/cli-copy-consistency.test.ts:1` checks nine surfaced console/vendor/doc files for old command aliases, then pins canonical run/grant/trace wording and matching no-install copy in peek/detail views. Command help is also held in code. [apps/console/src/app/(console)/components/cli-copy-consistency.test.ts:30-107; reference-implementation/vendor/cli/src/index.ts:22-67,162-188]

**Rough edges:** canonical copy uses `pdpp ...`, which fails if global CLI is absent; tests require parallel `npx` copy. Docs are not a complete in-product command catalog. `@pdpp/local-collector` README on this branch contains a stale warning that versions `1.3.0–1.5.4` are unrunnable and no fix exists yet; this is a docs snapshot, not a current registry check. [packages/local-collector/README.md:64-85]

## Driving it with Playwright

**Journey status:** `partly`. **Journey file:** `connect-an-mcp-client`. **Combined isolated run:** `connect-an-mcp-client`: **pass**.

**What it verifies:** The capture reaches the product instructions that contain command examples.

**Reaches:** The `/connect` page renders with its “Connect apps” heading and the client setup instructions.

**Stops at:** It does not launch a separate CLI process or verify a client command against the isolated server.

**Run one journey:**

```sh
TEST_SANDBOX_REQUIRE=1 scripts/test-sandbox/test-sandbox --net none --pidns --scratch "$VERIFY_DIR/sandbox-scratch" -- node e2e/harness.mjs capture.spec.ts --output "$VERIFY_DIR/playwright-output" --grep "journey: connect-an-mcp-client"
```

**Evidence:** `evidence/connect-an-mcp-client/<run-id>/` contains desktop and phone screenshots plus visible text.

## Gotchas

The CLI has its own command tests. This browser journey verifies the page copy and route only.
