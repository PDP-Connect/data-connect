# Spec-confidence oracles 0903 — research notes (WIP, no tests written yet)

Working notes for two interoperability tests that lift the last two sub-90 spec
decisions (pdpp children #310 and #311). Committed so the investigation survives
a session boundary. **No test code exists yet.**

## Branch base correction

The task specified `origin/main` (vana-com/data-connect). That remote is archived
and read-only — its README says so, and `origin/main` has no
`reference-implementation/` directory at all, so the work is impossible there.
The live repo is the `pdp` remote (PDP-Connect/data-connect); `pdp/main` carries
the reference implementation that Move B moved out of pdpp. This branch is cut
from `pdp/main`.

## Test 1 — provenance from the issued grant (#310)

Spec sentence under test (spec-core.md:778 on
`origin/spec/int0902-12v3-source-kind-request-field`):

> A selection request does not carry `source.kind`. The authorization server
> derives the provenance class from the declaration it accepted for `source.id`,
> and records it in consent evidence and any issued grant, where a client reads
> it back through introspection.

Supporting row, spec-core.md:760: "A request carries `id` alone: provenance is
derived by the authorization server from the accepted declaration, not asserted
by the client."

### What the code does today (read, not yet executed)

Two validators disagree, and resolving that disagreement is the point of the test:

- `server/auth.ts:1686-1730` is the PAR / `initiateGrant` path. It explicitly
  accepts `{id}` alone (`detailSourceKeys.length === 1 && detailSourceKeys[0] === "id"`)
  and derives kind at 1727-1730:
  `explicitKind || (acceptedSource ? acceptedSource.kind : null) || configuredSource?.kind || "connector"`.
  So the spec-conformant request shape is probably already accepted here.
- `server/core-source-authorization.ts:148-157` (`requireSourceBinding`) demands
  `hasExactKeys(["id","kind"])` and fails "Source must include only kind and id"
  when `kind` is absent. Same for `requireStructuredSourceBinding`
  (`server/auth.ts:2103-2119`).

Note the fallback chain ends in a literal `|| "connector"`. That default is the
thing worth pinning: for a `provider_native` source whose declaration is not
resolvable, the AS would silently record `connector` provenance rather than
failing. That is a provenance-trust defect if it reproduces.

Provenance *is* readable from the issued grant: `introspect`
(`server/auth.ts:11234`) reads the persisted grant via `getIntrospection`, and
`projectSourceIntrospectionWireContext`
(`server/source-introspection-context.ts:169-190`) emits both
`authorization_details[0].source` and `pdpp.source`, each `{id, kind}`.

### Test shape

Harness: copy `test/b3-introspection-resources-conformance.test.ts` (its
`withHarness`, `issueClientGrant`, `issueOwnerToken`, `fetchJson`, and
`TEST_INTROSPECTION_SERVER_OPTS`). Real server on ephemeral ports, in-memory
SQLite, no mocks of the server under test.

Both provenance classes:
- `connector` — `fixtures/seed-manifests/spotify.json` via `POST /connectors`,
  source id `https://registry.pdpp.dev/connectors/spotify`.
- `provider_native` — `fixtures/seed-manifests/northstar-hr.json`, source id
  `https://northstar.example/pdpp`, accepted through
  `retrieveAndAcceptProviderNativeDeclaration` as in
  `test/accepted-provider-native-consent.test.ts`.

Assert, for each kind: PAR with `source: {id}` only (no `kind`) → 201; approve;
introspect the issued token; `pdpp.source.kind` equals the accepted
declaration's kind; and a provenance-sensitive policy decision is made from that
value **before** any RS record read. Existing coverage only ever asserts
`kind === "connector"` (b3 test), so the `provider_native` leg is genuinely new.

## Test 2 — URL-hosted client identity (#311)

Spec sentence under test (spec-core.md:715 on
`origin/spec/int0902-13v3-registry-queries`):

> A conforming authorization server MUST NOT reject an otherwise valid client ID
> metadata document solely because the client is not preregistered. The server
> MAY deny authorization, rate-limit the client, or require a registry status
> under local policy.

Reliance-tuple sentence (spec-core.md:109, same branch):

> A registry answer identifies a status, the governance framework that conferred
> it by URI, and its validity window. An authorization server records the trust
> signal it relied on, including that framework URI, status, and validity, on its
> acceptance record or resulting grant.

The judge asks for a fuller tuple (subject, role/scope, status, framework URI,
issuer, valid_from, valid_until, lookup time) — a ToIP TRQP-shaped superset of
the three things Core actually requires. Test Core's three; report the gap to the
judge's fuller list rather than silently narrowing the ask.

### What the code does today (read, not yet executed)

Three legs, and they are in different states:

1. **Unregistered CIMD succeeds as an identity form** — likely already passes on
   the PAR path. `resolveOAuthClient` (`server/auth.ts:5530-5552`) tries
   `getRegisteredClient` first, then falls back to `resolveCimdClientForGrant`
   for any `https://` client_id. CIMD fetch/validation is thorough
   (`server/cimd.ts`, 589 lines; SSRF guard, 5 KB cap, same-origin redirect_uris,
   send-time address binding).
2. **A distinct local-policy denial** — the seam to check. `GET /oauth/authorize`
   (`server/routes/as-authorize.ts:833-840`) calls `ctx.getRegisteredClient` and
   returns 400 `invalid_client` "Unknown client_id", whereas PAR
   (`requireInitiationRegisteredClient`, `server/auth.ts:5559-5575`) goes through
   the CIMD-aware `resolveOAuthClient`. If the authorize route is wired to the
   non-CIMD lookup, a valid unregistered CIMD is rejected *for being
   unregistered* on that route — a direct MUST NOT violation. Confirm the
   `server/index.ts` wiring; do not assume.
3. **Reliance tuple retained** — **absent**. `grep` over `server/` for
   `framework_uri`, `trust_signal`, `valid_from`, `valid_until`, `registry_status`,
   `verified_domain` returns nothing. Nothing records which trust signal the AS
   relied on. This is the failing-first half and needs a server change to pass.

Existing CIMD coverage (`test/cimd.test.ts`, 609 lines) is entirely pure-unit
with injected `fetchImpl` — nothing exercises the registered→CIMD fallback
through a real HTTP route. That is the gap.

### Test shape

Serve the CIMD document from the AS's own origin via
`GET /oauth/client-metadata/:id` (`server/routes/client-metadata.ts`) so
`resolveCimdClientForGrant`'s same-origin branch resolves it from local storage.
This keeps the test hermetic — the suite installs a network guard
(`scripts/hermetic/preload.ts`) that fail-closed blocks ambient origins, so an
outbound CIMD fetch to a fake host will not work.

## How to run

Deps and workspace builds are already done in this worktree:

```
npm ci
npm --prefix packages/connector-protocol run build
npm --prefix packages/collector-runtime run build
npm --prefix reference-implementation/vendor/mcp-server run build
```

Single file (the suite runner takes no file argument):

```
cd reference-implementation
PDPP_TEST_PROFILE=memory-default PDPP_OWNER_PASSWORD=reference-implementation-ci \
  node --test --import tsx test/<file>.test.ts
```

Full suite is `npm --prefix reference-implementation run test` with the same env.
Note a full-suite run did not finish within 10 minutes here; prefer single-file
runs while iterating.

## Next steps

1. Run one existing test single-file to confirm the harness works in this
   worktree (a full-suite run was started and did not complete in time).
2. Empirically settle whether PAR accepts `source: {id}` without `kind`, on both
   provenance classes, rather than trusting the code read above.
3. Write both tests failing-first; record honestly what passes and what fails.
4. Identify the smallest server change for each failure; make no server change
   beyond what a test needs to compile.
5. Open the draft PR titled
   "test(spec): provenance-from-grant and CIMD identity interoperability oracles".
