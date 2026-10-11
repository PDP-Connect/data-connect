# RI lane P5: MCP child selection findings

Status: scoped prototype complete. Verification is complete with the full flag-off command failed and its affected files passing isolated reruns. Scope: inventory P5 step (1), #390e only.

Target: `spec-mcp-profile.md` at pdpp `a845f4b843` (PR #390 plus #391 freshness). RI baseline: data-connect `4e69b5dff8a52e3547444a6ac57d7d12dd6940b8`; branch `proto/ri-mcp-profile-slice`.

## Early observations

- The draft requires an explicit `grant_id` for each data-disclosing package tool call. Missing, malformed and unknown selectors must fail as MCP tool results before processing. A single-child tool meets this rule; fan-out is optional.
- The current `PackageRsClient` merges schema, stream and search results across children and routes record reads by `connection_id`. The current server instructions tell agents to persist `connection_id`, not `grant_id`, across reconnects. These are code observations, not yet test evidence.
- `getGrantPackageAccess` supplies only active members. The prototype must retain knowledge of an inactive package child to distinguish `package_child_inactive` from an unknown selector without selecting another child.
- PR #391 freshness and presentation `inputs`, pairwise record handles, downstream package endpoints, and lifecycle changes are later slices. This prototype makes no full MCP-profile conformance claim.
- The later local draft `8bae50600c` changes child-discovery wording to current read status; its extended-access profile renames `pdpp_grant_status` to `pdpp_grant_read_active`. Neither status operation nor rename is implemented here.

## Requirement verdicts

| Requirement | Verdict | Executable evidence |
|---|---|---|
| Every data-disclosing package tool declares `grant_id`; missing, malformed and unknown selectors fail before any read or expand preflight | held | `package profile rejects selectors on every disclosing tool before downstream reads` covers all six tools, invalid selectors, singleton packages and expand preflight with zero downstream requests. `package profile exposes selectors and blocks resource URI bypasses; ordinary surface stays unchanged` checks actual advertised schemas. |
| No implicit child selection, including one active child | held | `package profile rejects selectors on every disclosing tool before downstream reads` repeats the rejection matrix with one child. |
| No merged child constraints or results | held | `package profile uses only the selected child's schema and search, and preserves record data` exercises all six successful tools and records only the selected child's downstream requests. `prototype MCP profile selects explicit children and replacement tokens reject old grant selectors` checks real selected schema has no merged package metadata and rejects a different child's connection or embedded record handle. |
| Callable discovery has no selector and exposes only approved child metadata with current status | held | `package profile discovery and inactive errors do not read children` checks exact metadata and zero child reads. The real HTTP test checks the six allowed discovery keys, grant instance handles, and status changing after revocation. |
| Inactive selected child with live sibling returns MCP `isError`, `package_child_inactive`, child `grant_id`, ended/no-retry/ask-owner text; no transport 401/403 or substitution | held | `package profile discovery and inactive errors do not read children` checks revoked and expired selections on all six tools, HTTP 200, error shape and text with zero reads. The real HTTP test checks persisted expiry/revocation and successful sibling access. |
| Losing the final active child returns HTTP 401 with Bearer `invalid_token` | held | `prototype MCP profile selects explicit children and replacement tokens reject old grant selectors` revokes both children and checks the challenge. |
| Resource URIs and continuation handles cannot bypass explicit child selection | held | `package profile exposes selectors and blocks resource URI bypasses; ordinary surface stays unchanged` denies resource reads. The selected-child test follows an emitted field-window continuation with `grant_id` and checks source data with its own `tool`/`args` fields is not rewritten. `every package field-window text continuation replays verbatim without changing source evidence` replays the original next/previous hints, preserving chunk limits and source text that imitates a hint. |
| Stable selector behavior across re-consent | underspecified | `prototype MCP profile selects explicit children and replacement tokens reject old grant selectors` proves new child IDs and unchanged connection IDs, old-selector success under the old token and failure under the replacement token. The draft does not specify a stable source-to-child remapping contract. |

No requirement in this slice was found wrong. The held verdicts cover the tested implementation scenarios; they do not establish complete profile conformance or compatibility with external agent hosts. Optional multi-child fan-out is not offered, so its envelope rule was not exercised.

## Selector stability

The real consent flow issues two packages for the same client and connector connections. Their resolved `connection_id` sets are equal, their child `grant_id` sets are disjoint, and their grant stream/instance handles are unchanged. A saved old child ID still reads under the old package token after the second approval, but the replacement token rejects that ID as `unknown_grant_selector` with HTTP 200 and `isError:true`. Re-consent itself did not revoke the old grant in this experiment.

An agent that replaces its token after re-consent while retaining saved grant selectors cannot resume its saved schema/read calls with those selectors. The old `connection_id` still identifies the same connection in the RI's resolved access metadata, but it does not select a child under the prototype. Rediscovery supplies current child IDs; the draft does not specify how an agent maps a saved source identity to the new child. OAuth refresh and re-consent are different operations: existing RI package-refresh tests preserve the package ID. This report makes no selector design decision.

## Implementation observations

The installed MCP SDK wraps tool input-schema validation failures as HTTP 200 `isError` results. A permissive optional selector schema is not needed to preserve that transport behavior; the prototype advertises an explicitly required string selector. `server SDK input validation returns HTTP 200 tool errors before downstream reads` proves the SDK transport behavior; the strengthened schema check failed before the declaration changed, then passed. Missing/nonstring selectors return SDK tool errors; malformed string and unknown selectors return the prototype’s handler errors. This is an implementation observation, not a defect in the draft.

## Verification

The worker and parent each ran the six profile transport tests plus 47 legacy transport/formatter tests: 53 passed, 0 failed. After the restart, the parent rebuilt the final MCP artifact and ran the real HTTP flow plus two existing flag-off regressions: 3 passed, 0 failed. Package-client/internal-routing regressions also passed again with the flag off: 43 passed, 0 failed. RI/vendor typechecks and Biome checks of the two new files passed; added regions in existing files have no lint diagnostics.

The full flag-off command was:

```sh
PDPP_TEST_PROFILE=memory-default PDPP_PROTOTYPE_MCP_PROFILE=0 npm --prefix reference-implementation test
```

It exited 1 after 544 completed file results when `test/cli.test.ts` exceeded its 900,000 ms deadline. It also reported a transformer assertion failure. Follow-up groups and isolated CLI produced results for all 1,121 discovered RI test files. They do not establish a successful canonical full-suite run or complete-suite accounting closure.

| Run | File results | Passed assertions | Failed assertions | Skips | Raw log filename |
|---|---:|---:|---:|---:|---|
| Original full flag-off attempt; exited 1 on CLI deadline | 544 | 5,442 | 1 | 224 | `ri-p5-full-suite-off.log` |
| Flag-off continuation; interrupted by T3 restart | 461 | 4,215 | 4 | 127 | `ri-p5-remaining-suite-off.log` |
| Remaining flag-off group after restart; exited 0 | 115 | 1,042 | 0 | 41 | `ri-p5-after-restart-suite-off.log` |
| Isolated flag-off CLI; exited 0 | 1 | 140 | 0 | 0 | `ri-p5-cli-isolated-off.log` |

The T3 restart at 03:38Z stopped the first continuation. The last group used an external copy of the existing runner, rebound to the same repository and imports, with the same memory-default profile, flag off and four workers. No runner change is committed. PostgreSQL and external-model smoke skips remain explicit in the raw accounting events.

Three files with assertion failures passed isolated flag-off reruns:

- `local-transformer-executor.test.ts`: 17/17. `KILL-unconfirmed invokes fail-stop and deliberately retains generation promises` expected `transformer_exit_unconfirmed`, but the loaded run observed an empty list. The fake-executor path does not execute the new profile query. Timer scheduling is a hypothesis, not a proven cause. Raw log: `ri-p5-transformer-isolated-off.log`.
- `run-executor-timeout-honesty.test.ts`: 8/8. The loaded run observed emitted-record count 0 instead of 5 and `run_timed_out` instead of success for a local-only phase. These paths use owner authorization and connector ingestion; they do not invoke `/mcp` or opt-in package logic. The test documents a 400 ms progress allowance. Timing pressure is plausible, but the isolated pass does not prove the cause. Raw log: `ri-p5-run-timeout-isolated-off.log`.
- `ri-zero-connector-knowledge-conformance.test.ts`: 114/114 after cleanup. Its two failures flagged a hardcoded scratch path in the parent-created temporary runner. That runner was archived outside the repository and removed from the scanned tree while Node continued from memory. This was a verification artifact caused by the parent, not a production defect. Raw log: `ri-p5-knowledge-conformance-off.log`.

Scoped raw logs are `ri-p5-parent-continuation-tests.log` (53 tests), `ri-p5-final-built-http-tests.log` (3 tests), and `ri-p5-final-off-regressions.log` (43 tests). No unrelated executor or scanner repair is included. The repository-wide `npm --prefix reference-implementation run check` reports 2,233 errors, 4,196 warnings and 25 infos across 2,230 files, including formatting diagnostics in untouched files. No broad lint cleanup is included. PostgreSQL execution and external MCP hosts are unverified. Confidence is high for the scoped SQLite/HTTP scenarios and limited for those untested environments.

The independent dot review found no further concrete defect in the supplied helper/hosted adapter; it excluded resolver/auth/SQL and concurrent revocation enforcement. Its final helper review found a prototype continuation defect: original model-visible next/previous instructions omitted `grant_id` alongside appended scoped hints, so verbatim replay failed closed. The regression failed before repair and passed after the formatter received an optional presentation selector. It now inserts `grant_id` before joining generated hints with source text and preserves `limit_chars`; original search read/fetch hints also carry the selector. Legacy exact-string tests pass. This was a prototype defect, not evidence that the draft is wrong. Independent static review accepted the repair and found no additional concrete defect within that scope; it did not execute tests or review resolver/auth/SQL.

## Consumers of the MCP behavior

- Hosted `/mcp` package clients use `server/routes/rs-hosted-mcp.ts` and the vendored server. The console's `apps/console/src/app/(console)/connect/page.tsx` offers setup for Claude Code, Codex, ChatGPT, Claude.ai and other remote clients. These clients need the new discovery result and must pass a child grant ID on reads when the prototype is enabled. Actual external client compatibility has not been exercised.
- The vendored `@pdpp/mcp-server` API (`src/server.ts`, `src/index.ts`) and `bin/pdpp-mcp-server.ts` serve the same tool definitions. The local stdio CLI currently constructs an ordinary single-grant client; profile package behavior is injected only by the hosted package adapter.
- Shared `vendor/read-core` builds continuation descriptors for MCP results; those descriptors must carry the selected `grant_id`. Its other REST/console/CLI consumers retain their existing behavior. The console and CLI use REST reads, not MCP package tool calls.
- `scripts/railway-mcp-query-smoke.ts` calls hosted `query_records` with an ordinary Core client token. RI hosted-MCP tests, package-client tests and vendor MCP transport/artifact tests consume tool names, schemas, results, resources or server instructions. Flag-off checks must preserve those existing contracts.

Static inventory used source searches for `createPdppMcpServer`, `handleStreamableHttpRequest`, `buildTools`, `/mcp` and package-client call sites. No language-server bridge was available. This inventories repository consumers and setup-advertised clients; it cannot enumerate private integrations outside the repository.
