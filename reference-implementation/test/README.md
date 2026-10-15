# Reference implementation tests

Run the hosted MCP existing-client compatibility gate from a fresh shell with:

```sh
npm --prefix reference-implementation run test:mcp-existing-client-gate
```

The gate starts the real reference AS and RS, obtains a client token and a
two-child MCP package token through the hosted OAuth flows, then replays
initialize, tool and resource discovery, schema, search, fetch, query, aggregate,
and bounded field reads over HTTP. It checks nested structured output, model
visible text, search evidence, search-to-fetch identity, pagination, annotations,
legacy `connection_id` handles, record resource URIs, Unicode, large bounded
reads, error results, and empty search. `content[]` text behavior is pinned to
the base: summaries stay non-empty, and any base JSON mirror must remain a JSON
mirror of `structuredContent`.
Package-token selection may become explicit only when `tools/list` also offers
`list_package_children` and every data tool requires `grant_id`; the gate
discovers ids from that tool's result. The runner rejects every skipped or TODO
scenario unless its title names the explicit P2 or P4 identity-lane dependency,
and prints those pending scenarios.

The package resource scenario stores the record and field-window URIs disclosed
by the base package session. After the package identity change, the candidate
must resolve those old URIs through an unambiguous child mapping and advertise
new `grant_id` URI templates. It derives new URIs from the candidate's own
templates and child discovery output, then reads them over the hosted session.
Only a refusal with `ambiguous_legacy_resource_uri` is accepted when the stored
URI maps to multiple children. The unchanged base is checked against its exact
golden resource discovery; candidates that remove package templates, including
B1, P1, and B2, fail the dedicated package-resource scenario. Client-token
resource discovery must remain equal to base.

The committed golden contract was generated from
`3282ac2f5e4687419bf391c2294d2118dd63fd7c`. Its generator refuses to run from
another revision. To refresh deliberately, first check out the gate revision so
the generator and helper exist, then apply the gate to a detached worktree at
the exact integration base and run the copied generator there:

```sh
export GATE_SOURCE="$HOME/.tmp/wt-g0"
export BASE_WORKTREE="$HOME/.tmp/wt-g0-contract-base"
git -C "$GATE_SOURCE" worktree add --detach "$BASE_WORKTREE" 3282ac2f5e4687419bf391c2294d2118dd63fd7c
"$GATE_SOURCE/reference-implementation/test/scripts/apply-mcp-existing-client-gate.sh" "$BASE_WORKTREE"
npm --prefix "$BASE_WORKTREE/reference-implementation" run refresh:mcp-existing-client-contract
cp "$BASE_WORKTREE/reference-implementation/test/fixtures/mcp-existing-client-contract.json" \
  "$GATE_SOURCE/reference-implementation/test/fixtures/mcp-existing-client-contract.json"
```

Review the fixture diff. A commit that updates this contract must include a
commit-body line beginning `Contract update justification:` that explains why
the existing-client contract has changed.

To run this gate on any candidate worktree, check out this gate revision first,
then use its apply script. The script copies the five gate test files, shared
helper, seeder, runner, fixture and test README, then adds the npm script. It
does not commit candidate changes.

```sh
export GATE_SOURCE="$HOME/.tmp/wt-g0"
export CANDIDATE_WORKTREE="$HOME/.tmp/wt-candidate"
"$GATE_SOURCE/reference-implementation/test/scripts/apply-mcp-existing-client-gate.sh" "$CANDIDATE_WORKTREE"
npm --prefix "$CANDIDATE_WORKTREE/reference-implementation" run test:mcp-existing-client-gate
```

## Audience migration gate (waiting for identity-lane P2)

The P2→P3→P7 permanent-token scenario is marked TODO and skipped until the
identity lane has a worktree to run it against. It models the production
census: a non-expiring `mcp_package` token with no refresh family, its active
package children, non-expiring per-child Core `client` tokens with
`package_id = NULL`, and a non-expiring client token with no refresh family.
The scenario checks that the package and MCP client audiences resolve to
`/mcp`, child Core tokens resolve to the RS base audience and fail at `/mcp`,
undecidable legacy rows are dual-accepted and counted, and package MCP calls
continue after P7 retires the child tokens.

Run one migration boundary from its matching worktree. Export absolute paths
before using them:

```sh
export MCP_AUDIENCE_MIGRATION_WORKTREE="$HOME/.tmp/wt-identity-p2"
export MCP_AUDIENCE_MIGRATION_BASE_WORKTREE="$HOME/.tmp/wt-g0-base"
export MCP_AUDIENCE_MIGRATION_STAGE=P2
npm --prefix "$MCP_AUDIENCE_MIGRATION_WORKTREE/reference-implementation" run test:mcp-audience-migration
```

`MCP_AUDIENCE_MIGRATION_WORKTREE` names the identity-lane candidate checkout;
`MCP_AUDIENCE_MIGRATION_BASE_WORKTREE` names a checkout whose server code is
still at `3282ac2f5e` and seeds the SQLite database with real OAuth flows before
the candidate server starts. It seeds an MCP `/mcp` client token, a package
token and its internal child tokens, plus an unscoped OAuth code token whose
audience cannot be inferred. The test then restarts the database under the
candidate code so its startup migration sees actual PRE-P2 token rows. Set
`MCP_AUDIENCE_MIGRATION_STAGE` to `P2`, `P3`, or `P7` for the matching
identity-lane checkout. The test checks the selected candidate path is the
current test worktree. P7 retires the fixture's internal child token rows and
replays the package tool session to prove package access remains independent of
those bearers. This scenario does not use OAuth refresh: the census has no
active refresh tokens. The base branch has no audience column or migration
counter, so these assertions stay skipped until P2 exists.

## Stored-ID resolution gate (waiting for identity-lane P4)

This scenario captures the handles a client can store from a base session:
`connection_id` values, search and fetch ids, record URIs, and the bounded
`read_record_field` arguments. It seeds real hosted OAuth tokens and fixture
records on the unchanged base, saves the captured session beside the SQLite
database, then restarts that database under the candidate server and replays the
saved handles for both the client and package sessions. It requires every
captured handle to resolve and the observed legacy `connection_id` values to
remain the same.

The scenario is explicitly pending until an identity-lane P4 worktree exists.
Run it from that worktree with absolute worktree paths:

```sh
export MCP_STORED_ID_WORKTREE="$HOME/.tmp/wt-identity-p4"
export MCP_STORED_ID_BASE_WORKTREE="$HOME/.tmp/wt-g0-base"
export MCP_STORED_ID_BASE_REV=3282ac2f5e4687419bf391c2294d2118dd63fd7c
npm --prefix "$HOME/.tmp/wt-identity-p4/reference-implementation" run test:mcp-existing-client-gate
```

The scenario verifies that the seeder is exactly
`MCP_STORED_ID_BASE_REV` (default `3282ac2f5e4687419bf391c2294d2118dd63fd7c`)
and that the candidate is a different revision. It requires nonzero captured
counts for connection ids, search ids, fetch ids, record URIs, and field-window
arguments. The normal runner validates every expected TAP scenario and prints
the P2 and P4 scenarios that remain pending. It fails if an active scenario is
missing, renamed, skipped, or not executed.

## Other observed base behavior

The active gate records error-result shapes for a bad tool call, an unknown
stream and an unknown fetch id. Bad calls return MCP `isError: true`; empty
search returns a successful empty `results` array. `resources/list` and
`resources/templates/list` are captured in the golden discovery contract. The
long fixture contains more than 2,000 characters and Unicode; a 240-character
window returns 241 characters at most because the base window uses an inclusive
end offset. The gate asserts those characters appear in the model-visible text.
Record fetch handles do not have an expiry field; they identify records and are
resolved under the current bearer grant. The gate covers an unknown record id.
The production census found non-expiring bearer tokens, so an expired-bearer
scenario is outside this base contract until token expiry is introduced.
