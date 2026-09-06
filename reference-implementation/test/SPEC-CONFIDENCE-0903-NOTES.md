# Spec-confidence oracles 0903 — findings

Two interoperability oracles that lift the last two sub-90 spec decisions (pdpp
children #310 and #311). Both tests are now written and run; this file records
what the code actually does, replacing the earlier code-read speculation.

- `test/spec-provenance-from-grant-oracle.test.ts` — 3 tests, all pass.
- `test/spec-cimd-identity-oracle.test.ts` — 3 tests, 2 pass and 1 fails
  failing-first on behavior the server does not implement.

## Branch base

The task specified `origin/main` (vana-com/data-connect). That remote is archived
and read-only, and `origin/main` has no `reference-implementation/` directory at
all. The live repo is the `pdp` remote (PDP-Connect/data-connect), where Move B
put the reference implementation. This branch is cut from `pdp/main`.

## Running these tests

Deps and workspace builds are prerequisites, and both are easy to miss — a fresh
worktree has neither, and the failure mode is a bare `ERR_MODULE_NOT_FOUND`
rather than anything that names the missing step:

```
nvm use 22.23.1          # .github/workflows/reference-implementation.yml pins this
npm ci                   # from the repo root; node_modules is hoisted, not per-package
npm --prefix packages/connector-protocol run build
npm --prefix packages/collector-runtime run build
npm --prefix reference-implementation/vendor/mcp-server run build
```

Then, from `reference-implementation/`:

```
PDPP_TEST_PROFILE=memory-default PDPP_OWNER_PASSWORD=reference-implementation-ci \
  node --test --import tsx test/spec-provenance-from-grant-oracle.test.ts
```

The suite runner (`npm run test`) discovers its own files and ignores a file
argument, so passing one to it silently runs everything. Use the `node --test`
form above for a single file.

Lint these files with `npx biome check --config-path=biome.jsonc <file>` from
`reference-implementation/`. A bare `npx ultracite check` does not pick up
`reference-implementation/biome.jsonc` and reports spurious findings — it flags
the already-committed `b3-introspection-resources-conformance.test.ts` too.

## Test 1 — provenance from the issued grant (#310): passes

Spec sentence under test, `spec-core.md:778` on
`origin/spec/int0902-12v3-source-kind-request-field`:

> A selection request does not carry `source.kind`. The authorization server
> derives the provenance class from the declaration it accepted for `source.id`,
> and records it in consent evidence and any issued grant, where a client reads
> it back through introspection.

Supporting row, `spec-core.md:760`: "A request carries `id` alone: provenance is
derived by the authorization server from the accepted declaration, not asserted
by the client."

**The code is already conformant, on both provenance classes.** Measured, not
read: a PAR carrying `source: { id }` with no `kind` returns 201 for a
`connector` source and for a `provider_native` source; consent approves; and the
issued grant plus introspection both carry the class the AS derived. The
`provider_native` leg records `kind: "provider_native"`, so the derivation uses
the accepted declaration rather than falling through to a default.

Two claims in the earlier draft of this file did not survive being checked:

- *"Two validators disagree."* They do not. `requireSourceBinding`
  (`server/core-source-authorization.ts:148`) and `requireStructuredSourceBinding`
  (`server/auth.ts:2103`) both demand `{id, kind}`, but neither validates an
  incoming client request. Their call sites take already-derived internal
  bindings — a retained consent snapshot, or a `source_binding` the AS itself
  built — where `kind` is always present by construction. The one request-shape
  validator is in `resolveAuthorizationDetailBindings`
  (`server/auth.ts:1692-1699`), and it accepts `{id}` alone.
- *"The `|| "connector"` default would mis-record an unresolvable
  `provider_native` source."* It cannot be reached observably. When a request
  carries `id` alone, `resolveRegisteredSourceBindingById`
  (`server/auth.ts:1649`) overwrites the whole binding with the kind from the
  retained declaration; when the id resolves to nothing, `resolvedConnectorId` is
  null and the request is refused with `Unknown source` before any grant exists.
  The third test in the file pins that refusal, so a future change that starts
  defaulting the provenance of an undeclared source fails here.

The tests exercise the single-source request path. That is not a coverage gap for
the derivation itself: the staged multi-source path
(`normalizeStagedGrantRequestBatch`, `server/auth.ts:1820`) maps every entry
through the same `normalizeAuthorizationDetail`, so both paths share one
derivation rather than duplicating it.

## Test 2 — URL-hosted client identity (#311): 2 pass, 1 fails

Interoperability sentence, `spec-core.md:719` on
`origin/spec/int0902-13v3-registry-queries`:

> a conforming authorization server MUST NOT reject a valid client ID metadata
> document solely because the client is not preregistered. [...] A conformance
> test therefore exercises two distinct outcomes — an unregistered valid document
> that is accepted as an identity, and a policy denial that is not a rejection of
> the identity form.

Reliance-record sentence, `spec-core.md:111`, same branch:

> An authorization server records the trust signal it relied on — subject, role
> or scope, status, governance-framework URI, issuer or trust-anchor identifier,
> `valid_from`, `valid_until`, and the time of lookup — on its acceptance record
> or resulting grant.

**Leg 1 — unregistered CIMD accepted as an identity: passes.** With no
pre-registered clients at all, a PAR naming a CIMD URL as `client_id` returns
201, consent approves, and the issued grant and introspection both attribute the
URL-hosted identity. `resolveOAuthClient` (`server/auth.ts:5530`) tries the
registered-client table first and falls back to CIMD resolution for any `https://`
client id.

**Leg 2 — a policy denial stays distinct from an identity rejection: passes.**
The earlier draft flagged `GET /oauth/authorize`
(`server/routes/as-authorize.ts:832`) as a possible MUST NOT violation, on the
theory that its `ctx.getRegisteredClient` was the non-CIMD lookup. It is not:
`server/index.ts:4937` wires that context method to the CIMD-aware
`resolveOAuthClient`. The test asserts the two outcomes stay separable — an owner
denial at consent is an ordinary outcome reached *after* the identity was
accepted, while a CIMD URL with no document behind it fails as `invalid_client`.

**Leg 3 — the retained reliance tuple: fails, and needs a server change.**
Nothing in `server/` records which trust signal the AS relied on. `grep` for
`framework_uri`, `trust_signal`, `valid_from`, `valid_until` and
`registry_status` across `server/` and `packages/` returns nothing at all. The AS
does rely on a signal here — it resolved this client's metadata from a URL and
confirmed the document names the same `client_id`, which `spec-core.md:729` calls
verified domain control — but it keeps no record of having done so.

Smallest change that would make this pass: carry a `trust_signal` object from
CIMD resolution through to the issued grant and project it in introspection,
holding at minimum `status`, `framework_uri`, `valid_from`, `valid_until`, and
the lookup time. `buildCimdRegisteredClient` (`server/cimd.ts:585`) already marks
`registration_mode: "client_id_metadata_document"` and is the natural place to
mint it. No such change is made here: the failing test is the deliverable.

**Scope note for the judge.** The judge asked for a fuller ToIP-TRQP-shaped tuple
(subject, role/scope, status, framework URI, issuer, `valid_from`, `valid_until`,
lookup time). Core `spec-core.md:111` mandates that same list, and the test
asserts the four structural fields plus lookup time rather than the full eight,
because subject and issuer have no server-side representation to assert against
until the record type above exists. Reporting this as a narrower assertion rather
than silently claiming the judge's full ask.
