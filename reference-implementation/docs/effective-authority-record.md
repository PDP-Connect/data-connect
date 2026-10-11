# Per-run effective authority

Collection Profile [3.3.9](https://github.com/PDP-Connect/data-connectors/blob/8df6405e4adaecba5e70e32493d31856286d57d6/docs/spec/collection-profile.md#339-negotiation-and-the-effective-authority-record) requires a record of the authority resolved for a run before its first possible egress. The profile leaves the record's member names provisional; this runtime uses `schema_version: 1`.

The runtime persists `run.effective_authority` before spawning a collection-profile child. A failed write prevents spawn. The event contains `data.effective_authority`, bound to the run, connector, configured connection, owner subject, and deployment policy. The record includes every declared binding and every undeclared handle actually included in START. Handle values and credentials are excluded.

`instances` is keyed by binding instance name. Each entry contains `kind`, `interface`, `required`, `declared`, `lifecycle`, `requested_constraints`, `effective_constraints`, `effective_reach`, `mechanism`, and `channels`. Top-level filesystem `inputs` are normalized into requested constraints. Each input, output slot, and desktop-session item has its own channel. Observation status and attempts are separate from coverage.

The `reference-local-child-v1` deployment policy permits the existing unconfined Node-child deployment. Its `weaker_coverage` list authorizes each granted instance/channel separately with a rationale. This runtime does not mediate destinations or file access. Each channel reports `not_observable`, an empty attempt list, and no effective constraint limit. A granted instance reports `effective_reach: unconfined`. `remaining_ambient_access` also identifies host network, host filesystem, passed run credentials, and child-process access. These fields must not be displayed as containment. Adding enforcement or observation requires changing the record producer as well as the placement policy.

Both read-only endpoints call `readRunEffectiveAuthority` and return the same persisted body:

- `GET /_ref/runs/:runId/effective-authority` on the authorization server requires an owner session cookie.
- `GET /v1/owner/runs/:runId/effective-authority` on the resource server requires an owner bearer.

The bounded SQLite/PostgreSQL lookup does not depend on timeline pagination, current manifests, or active-run memory. A legacy run without a record returns `404 not_found`; its authority is never reconstructed from its current manifest.

Named-instance placement depends on conformance item 10. This producer already accepts instance-keyed START bindings and retains separate entries for instances with the same kind. When that lane lands, feed its negotiated START binding map into this producer. This change does not add a console display or claim full Collection Profile containment conformance.
