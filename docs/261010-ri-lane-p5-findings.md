# RI lane P5: MCP child selection findings

Status: independent-review repairs complete; final verification recorded below. The initial full flag-off command failed; its affected files passed isolated reruns. Scope: inventory P5 step (1), #390e only.

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
| No merged child constraints or results | held | `each selected child serves every tool alone, with per-call traces and operation-specific results` exercises both children across all six tools, checking each call's downstream path and bearer separately. Its always-first-child mutation is detected. `prototype MCP profile selects explicit children and replacement tokens reject old grant selectors` checks real selected schema has no merged package metadata. Both children have real same-key records in the same stream; own fetch, field and query controls pass, while sibling record IDs and query/search scopes fail without either sentinel. |
| Callable discovery has no selector and exposes only approved child metadata with current status | held | `package profile discovery and inactive errors do not read children` checks exact metadata and zero child reads. The real HTTP test checks the six allowed discovery keys, grant instance handles, and status changing after revocation. |
| Inactive selected child with live sibling returns MCP `isError`, `package_child_inactive`, child `grant_id`, ended/no-retry/ask-owner text; no transport 401/403 or substitution | held | `package profile discovery and inactive errors do not read children` checks revoked and expired selections on all six tools, HTTP 200, error shape and text with zero reads. The real HTTP test checks persisted expiry/revocation and successful sibling access. |
| Losing the final active child returns HTTP 401 with Bearer `invalid_token` | held | `prototype MCP profile selects explicit children and replacement tokens reject old grant selectors` revokes both children and checks the challenge. |
| Resource URIs and continuation handles cannot bypass explicit child selection | held | `package profile exposes selectors and blocks resource URI bypasses; ordinary surface stays unchanged` denies resource reads. The selected-child test follows an emitted field-window continuation with `grant_id` and checks source data with its own `tool`/`args` fields is not rewritten. `every package field-window text continuation replays verbatim without changing source evidence` replays the original next/previous hints, preserving chunk limits and source text that imitates a hint. |
| Stable selector behavior across re-consent | underspecified | `prototype MCP profile selects explicit children and replacement tokens reject old grant selectors` proves new child IDs and unchanged connection IDs, old-selector success under the old token and failure under the replacement token. The initial draft does not specify rediscovery or saved-pagination recovery. A replacement child reads successfully, but replaying a saved lexical cursor returns `invalid_cursor`; restarting the search and paging with a new cursor succeed. |

No requirement in this slice was found wrong. The held verdicts cover the tested implementation scenarios; they do not establish complete profile conformance or compatibility with external agent hosts. Optional multi-child fan-out is not offered, so its envelope rule was not exercised.

## Selector stability

The real consent flow issues two packages for the same client and connector connections. Their resolved `connection_id` sets are equal, their child `grant_id` sets are disjoint, and their grant stream/instance handles are unchanged. A saved old child ID still reads under the old package token after the second approval, but the replacement token rejects that ID as `unknown_grant_selector` with HTTP 200 and `isError:true`. Re-consent itself did not revoke the old grant in this experiment.

An agent that replaces its token while retaining saved grant selectors cannot resume saved reads with those selectors. The revised test rediscovers a matching child, inspects all persisted replacement restrictions and its own expiry, and explicitly selects it; the reads succeed. Saved lexical search cursors still fail under that child because the snapshot is bound to old grant authority. Restarting the search and using its new cursor succeeds. Stable connection/instance handles help discovery but confer no authority. OAuth refresh is different: existing RI package-refresh tests preserve the package ID. This report proposes recovery guidance without choosing a selector-stability policy.

## Independent review repairs

Review: `local/research/dc-pr358-review.md`, reviewed RI head `173098ff956c2092118ae63d15c954ca6c91b93c`.

| Finding | Verdict | Failing-before and repaired evidence |
|---|---|---|
| S1: re-consent breaks saved selectors and lexical search cursors | underspecified client recovery in the initial MCP draft; held server authority rejection | `package instructions explain explicit rediscovery and restarting grant-bound searches` failed before the instruction update. `prototype MCP profile selects explicit children and replacement tokens reject old grant selectors` now seeds three searchable records, reselects a current child, reads successfully, rejects the old cursor, and restarts/paginates successfully. |
| S2: nonexistent records did not prove isolation | wrong test fixture; repaired | The added own-record control failed before fixture repair (`each child's real record must be readable`, `true !== undefined`). The same HTTP test now seeds both children with the same stream and three shared keys, but distinct subjects. A temporary mutation that discards a foreign binding and returns the selected child's same-key record fails `query_records cannot use another child's connection`; the temporary test was removed after the run. Own fetch/field/query controls pass; sibling fetch/field/query/search calls reject real records and disclose neither child's sentinel. |
| S3: first-child selection, cumulative traces and static windows concealed regressions | wrong test fixture/assertions; repaired | `each selected child serves every tool alone, with per-call traces and operation-specific results` failed on the old aggregate fixture. `field-window continuations replay at the requested offsets and reach both boundaries` failed with `0 !== 16` on the old offset-independent fixture. The repaired windows depend on offset/limit, and both-child per-call assertions pass. `field-window continuations replay at the requested offsets and reach both boundaries` checks next/previous/final behavior. Two injected adapter faults prove the assertions detect always-first-child and dropped-offset behavior. |
| N1: error results have different shapes | underspecified common envelope; held required inactive-child shape | `package instructions explain tool failures without a structured error envelope` failed before the instructions mentioned `isError` and text-only errors. `package errors preserve SDK, selector, inactive, downstream and adapter families` pins the matrix below. No normalization is required by this draft. |
| N2: vendor checks fail at this repository layout | held review observation; unresolved baseline limitation | Two token-budget tests import a doubled RI path; the setup-document assertion reads an absent file. These checks and paths are unchanged by this slice. The inherited vendor `npm test` wrapper also points to an absent RI-local runner. They remain visible in verification; no unrelated repair is included. |

S1's permanent HTTP scenario replaces the empty fixture, rather than correcting cursor rejection. Search authority is intentionally unchanged. S2/S3 exposed test defects, not a new production isolation defect. B1/B2/B3 remain explicitly deferred: package endpoints and forwarded selectors, pairwise record identity, and freshness/presentation provenance.

### Re-consent and pagination evidence

The replacement package has new child IDs but unchanged discovery handles. The fixture examines the complete persisted replacement grant, including fields and time constraints, before choosing the single matching child. This is an in-process test inspection, not evidence that an external host preserves or inspects the complete OAuth authorization result. Several matching children would require an explicit choice; the fixture has one match.

A saved lexical cursor pages successfully with its original child. Under the replacement token, the old child ID returns `unknown_grant_selector`. A freshly discovered child reads the same records successfully, but its use of that old cursor returns MCP `isError`, `invalid_cursor`, and “Cursor does not match this query and grant authority”. Starting the same search without the cursor succeeds, and its new next-page cursor advances to a different record. Replacing the selector alone cannot recover a saved search continuation. No old-ID alias, sibling substitution, or transfer of old authority is added.

The lexical snapshot authority hash includes the actor and complete grant. The semantic implementation uses the same mechanism, but semantic re-consent was not tested with a live model. Field-window continuations use numeric offsets; record-list pagination has a different codec. This experiment does not establish the lifecycle of every continuation.

### Does `fix/390-mcp-rediscovery` cover cursors?

Read the branch tree pinned at pdpp `8957a4d2d1399b04bf8f8bd493f8209fa73ff465`, without changing that branch. MCP §4 now explains stable source/instance discovery hints, inspection of the complete new result, explicit selection, possible ambiguity, and no substitution. It does **not** explain discarding or restarting search continuations after re-authorization.

The same tree's extended-access §5.2 already says that cursors are bound to the selected child and requires `invalid_cursor` under another child. Thus the branch covers the server's cursor-binding rule, but its new MCP rediscovery guidance does not cover the client's pagination recovery. Commit `8957a4d2d1` itself edits the access profile; the MCP rediscovery paragraph is present in its tree from an earlier change.

Proposed addition immediately after the rediscovery paragraph in MCP §4 (informative; proposal only):

> Stable source and instance handles do not make pagination state portable across grants. After choosing a child under replacement authorization, a client should discard search cursors and other continuations bound to the previous child and restart the affected query. Replacing the saved call's `grant_id` does not renew its cursor. The resource server still enforces the selected-child cursor binding in the extended access profile. Other continuation types retain the lifecycle defined by their resource-server contract.

This adds recovery guidance to the existing binding rule. It does not propose a stable grant ID, automatic remapping, or cursor migration. Whether the profile should require more client behavior remains a spec design question.

### Error-family matrix

All rows below return HTTP 200 with MCP `isError: true` and text. Evidence: `package errors preserve SDK, selector, inactive, downstream and adapter families`.

| Failure | `structuredContent` |
|---|---|
| Missing/nonstring selector or another SDK input-schema failure | Absent; SDK input-validation explanation is in text. |
| Malformed string selector | `error.code = invalid_grant_selector`, plus `message`. |
| Unknown selector | `error.code = unknown_grant_selector`, plus `message`. |
| Inactive selected child with live sibling | `error.code = package_child_inactive`, `grant_id`, and `message`; text says ended/no retry/ask owner. |
| Ordinary downstream RS failure | RS `error` plus `provider_url`, `http_status`, and `request_id`; an HTTP request ID can also be carried inside `error`. |
| Thrown adapter failure | `error.type = adapter_error`, `code`, and `message`. |

Clients must use the tool's `isError` flag and read its text without assuming every error has the same structured envelope. The draft mandates the inactive-child shape, not a common shape for every other failure. The new instructions make this visible to agents.

## Implementation observations

The installed MCP SDK wraps tool input-schema validation failures as HTTP 200 `isError` results. A permissive optional selector schema is not needed to preserve that transport behavior; the prototype advertises an explicitly required string selector. `server SDK input validation returns HTTP 200 tool errors before downstream reads` proves the SDK transport behavior; the strengthened schema check failed before the declaration changed, then passed. Missing/nonstring selectors return SDK tool errors; malformed string and unknown selectors return the prototype’s handler errors. This is an implementation observation, not a defect in the draft.

## Verification

The worker and parent each ran the six profile transport tests plus 47 legacy transport/formatter tests: 53 passed, 0 failed. After the restart, the parent rebuilt the final MCP artifact and ran the real HTTP flow plus two existing flag-off regressions: 3 passed, 0 failed. Package-client/internal-routing regressions also passed again with the flag off: 43 passed, 0 failed. Initial RI/vendor typechecks and default Biome checks of the two new files passed. Current checks and inherited repository diagnostics are recorded below.

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

## Verification after independent-review repair

Run from this worktree with the profile flag off outside the opt-in HTTP test:

| Run | Pass | Fail | Skip | Raw log |
|---|---:|---:|---:|---|
| Ten RI files: complete hosted OAuth, package client, internal routing, package lifecycle/bounds/expiry/PostgreSQL path, lexical/semantic operations and cursor isolation | 251 | 0 | 1 | `ri-p5-review-ri-suite.log` |
| Final profile transport tests, including both children, per-call traces, pagination mutations, initialized instructions and error-family matrix | 13 | 0 | 0 | `ri-p5-final-profile-tests.log` |
| Final rebuilt-artifact HTTP consent/isolation/re-consent recovery scenario | 1 | 0 | 0 | `ri-p5-final-http-tests.log` |
| All 23 vendor `*.test.ts` files | 185 | 3 | 0 | `ri-p5-review-vendor-suite.log` |

The three vendor failures are the same N2 doubled-import/setup-document failures recorded in the independent review. Two prevent their test files loading. The inherited vendor `npm test` wrapper is also absent at this layout; these runs use the actual repository-root scratch/Node wrappers. This is not a full vendor-suite green claim.

Final RI typecheck and MCP source-only typecheck pass. The full vendor typecheck reports only the two N2 missing token-budget imports; the changed profile test has no type diagnostics. Default Biome checks of the profile source/test pass using the same tab/80-column rules as their existing formatting. The RI-config OAuth check retains diagnostics in untouched regions and the unchanged request-counter increment; added test regions have no diagnostics. These are narrower claims than a repository-wide lint pass.

The RI group uses the existing scrubbed test environment, memory-default storage profile, disabled auto-enrollment, ephemeral ports, two-file concurrency, hermetic preload and scratch ownership wrapper. The temporary selected-file runner lives outside the repository. The full canonical flag-off RI run above was not repeated after these test/instruction repairs; its previous failed status remains. PostgreSQL execution, external MCP hosts, ambiguous replacement choices, narrower replacement grants, live-model semantic re-consent, concurrent revocation and the new inactive-member query above 256 members remain unverified.

Failing-before logs: `ri-p5-s2-before.log` (positive own-record control against the old empty fixture); `ri-p5-s3-before.log` (aggregate and offset-progress controls against the old static fixture); `ri-p5-final-instructions-before.log` (both final initialize-instruction tests against pre-fix instructions). Mutation logs: `ri-p5-s2-isolation-mutant.log`; the two vendor adapter faults are permanent tests. The shape matrix's first probe also exposed a request ID copied into the RS error; its assertion was corrected to match the observed family, without production normalization.

Raw commands and output are consolidated in `/home/tnunamak/.tmp/ri-p5-review-raw-test-output.log`. The proposed text above is only in this report; no pdpp spec branch was edited.

## Consumers of the MCP behavior

- Hosted `/mcp` package clients use `server/routes/rs-hosted-mcp.ts` and the vendored server. The console's `apps/console/src/app/(console)/connect/page.tsx` offers setup for Claude Code, Codex, ChatGPT, Claude.ai and other remote clients. These clients need the new discovery result and must pass a child grant ID on reads when the prototype is enabled. Actual external client compatibility has not been exercised.
- The vendored `@pdpp/mcp-server` API (`src/server.ts`, `src/index.ts`) and `bin/pdpp-mcp-server.ts` serve the same tool definitions. The local stdio CLI currently constructs an ordinary single-grant client; profile package behavior is injected only by the hosted package adapter.
- Shared `vendor/read-core` builds continuation descriptors for MCP results; those descriptors must carry the selected `grant_id`. Its other REST/console/CLI consumers retain their existing behavior. The console and CLI use REST reads, not MCP package tool calls.
- `scripts/railway-mcp-query-smoke.ts` calls hosted `query_records` with an ordinary Core client token. RI hosted-MCP tests, package-client tests and vendor MCP transport/artifact tests consume tool names, schemas, results, resources or server instructions. Flag-off checks must preserve those existing contracts.

Static inventory used source searches for `createPdppMcpServer`, `handleStreamableHttpRequest`, `buildTools`, `/mcp` and package-client call sites. No language-server bridge was available. This inventories repository consumers and setup-advertised clients; it cannot enumerate private integrations outside the repository.
