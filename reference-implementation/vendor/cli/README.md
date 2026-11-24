# @pdpp/cli

Command-line tools for PDPP providers.

## Status

This package is the public npm home for the `pdpp` command. The CLI
supports four command namespaces:

- **`pdpp connect <provider-url>`** — delegated access: discovers provider
  metadata, self-registers a public client when the AS advertises dynamic
  registration, asks the owner to approve scoped access in the browser, and
  stores scoped client credentials in the project-local `.pdpp/` cache without
  asking for an owner bearer token.

- **`pdpp owner-agent <onboard|status|control|connectors|setup|revoke>`** — trusted owner-agent
  onboarding for a local assistant the operator has authorized to act on their behalf.
  This is owner-level local automation, deliberately separate from the default
  grant-scoped `pdpp connect` path; ordinary agents should not use it.
  `onboard <entrypoint-url>` discovers the `pdpp_owner_agent_onboarding`
  advisory block (falling back to the RFC 8628 device-authorization shape in
  authorization-server metadata), runs browser-mediated owner approval, and
  writes the issued credential to a local file with `0600` permissions. The
  bearer is never printed; only the verification URL, code, and non-secret
  status are shown. The credential defaults to `~/.pdpp/owner-agents/<host>.json`; pass
  `--credential-file` to choose another location. The file stores the
  bearer as top-level `access_token` for local agents. `status` introspects the
  stored credential. `control` lists the non-secret owner-agent control
  capabilities (`GET /v1/owner/control`) and configured connection instances
  (`GET /v1/owner/connections`) — each connection's `connection_id`, connector,
  and label/label-needed state — so a trusted agent can discover what it can do
  and what is configured without printing the bearer. `connectors list`,
  `connectors search <query>`, and `connectors explain <connector-id>` read the
  non-secret connector-template catalog (`GET /v1/owner/connector-templates`) so
  a human or agent can discover Amazon/Gmail/Slack-like setup options before
  starting anything. These discovery commands are read-only and do not mint
  enrollment codes. `setup <connector-id>` is the start command: it requests the
  same non-secret connection setup plan and next-step contract the console
  add-source flow and owner-agent REST surface, by calling the shared server
  planner (`POST /v1/owner/connections/intents`). It sends the stored bearer only
  as an `Authorization` header, formats the plan's support state (`supported`,
  `proof-gated`, `unsupported`, `deployment-blocked`), modality, and primary
  owner next step, and surfaces owner-openable setup material (enrollment codes,
  enroll endpoints, runbook paths) when present. Pass `--display-name <name>` to
  label the resulting connection. No connection is created by this call; it
  materializes only when the owner-mediated step completes. The setup plan never
  includes provider secrets, owner cookies, browser cookies, or grant-scoped MCP
  bearer material, and the bearer is never printed. `revoke` deletes its
  dynamically registered client via the owner-session-gated RFC 7592 dashboard
  path; run `pdpp ref login <authorization-server>` first or provide
  `PDPP_OWNER_SESSION_COOKIE`. Owner-agent bearers are REST/control-plane
  credentials; `/mcp` rejects them. Routine chat-hosted and task-scoped agents
  should use the grant-scoped `pdpp connect` / MCP path instead, not an owner
  bearer.

- **`pdpp collector <advertise|enroll|run>`** — operator surface for the
  local collector runner. Pairs a host the operator controls (Claude Code or
  Codex CLI data) with a remote PDPP reference deployment via device-scoped
  enrollment, then runs connectors that the provider/control-plane container
  cannot run on its own. The runner ships separately as
  `@pdpp/local-collector` and owns the `pdpp-local-collector` binary; `pdpp
  collector ...` is a slim `@pdpp/cli` shim that resolves that package lazily.
  Public onboarding should use `npx -y @pdpp/local-collector ...` or
  `npm i -g @pdpp/local-collector`, unless the operator intentionally wants
  the `@pdpp/cli` shim.

- **`pdpp ref ...`** — reference operator diagnostics over `_ref` routes on a
  running reference deployment. Current subcommands: `pdpp ref run timeline
  <run-id>`, `pdpp ref grant timeline <grant-id>`, `pdpp ref trace show
  <trace-id>`. Requires `PDPP_OWNER_SESSION_COOKIE` when owner auth is enabled.
  These are reference-only operator tools, not core PDPP protocol.

## Install

```bash
# @pdpp/cli package, npx-launched pdpp binary
npx -y @pdpp/cli --help
```

When working from this monorepo without installing or linking the binary, use
the workspace executable:

```bash
# @pdpp/cli package, workspace-launched pdpp binary
pnpm exec pdpp ref run timeline <run-id>
```

The public command surface is still the `pdpp` binary; `pnpm exec` is only the
local workspace launcher.

The local collector runtime is a separate public package:

```bash
# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
npx -y @pdpp/local-collector advertise

# @pdpp/local-collector package, installs the pdpp-local-collector binary
npm i -g @pdpp/local-collector
pdpp-local-collector advertise
```

## Ownership And Publishing

The intended npm scope is `@pdpp`, owned by the durable PDPP/Vana project
organization rather than an individual maintainer. Normal publication is handled
by semantic-release from GitHub Actions using npm trusted publishing/OIDC and
registry provenance when the source repository is public. npm does not support
provenance for packages published from private GitHub repositories, so
`publishConfig.provenance` stays disabled until this repository is public.

After the package exists on npm, configure the trusted publisher with npm CLI
11.5.1+:

```bash
# npm trust command for the @pdpp/cli package publisher config
npm trust github @pdpp/cli --repo PDP-Connect/pdpp --file semantic-release.yml
npm trust list @pdpp/cli
```

The existing organization `NPM_TOKEN` may be used only to bootstrap first
package creation or recover from an emergency publishing incident. It is not the
steady-state release credential. If used, it must be granular,
automation-scoped, time-limited, rotated after use, and removed from the normal
release path once npm trusted publishing is verified.

## Read selectors, completeness, and errors

Every `pdpp read` command accepts `--connector-id <id>` and
`--connection-id <id>`. These selectors pass through to the server and narrow
the read. The CLI does not guess a connection or retry an ambiguous read;
errors preserve the server's `available_connections` choices.
Unknown flags fail before a request and list the valid flags for that command.

Reads write returned rows to stdout even when results are incomplete.
A `partial_results` warning, or `has_more: true` without `next_cursor`, returns
`incomplete_results` and exits 7 in JSON, JSONL, and table formats.
Use `--allow-partial` to accept those rows with exit 0 and a stderr warning.
A page with `has_more` and `next_cursor` succeeds; use the cursor for the next
request. There is no automatic cross-connection paging.

In JSON mode (the default), read failures write a JSON object to stderr with
`code`, `message`, `status`, `param`, `request_id`, and `retryable`. Unavailable
values are null. Connection choices are included when supplied by the server.
JSONL and table modes write concise one-line errors to stderr.
The following exit codes apply to `pdpp read`:

| Exit code | Meaning |
| --- | --- |
| 0 | Success, including explicitly accepted partial results |
| 1 | Other HTTP failure |
| 2 | Invalid arguments or unavailable cached credentials |
| 3 | Authentication failure (HTTP 401) |
| 4 | Insufficient scope (HTTP 403) |
| 5 | Not found (HTTP 404) |
| 6 | Network failure |
| 7 | Incomplete results |
