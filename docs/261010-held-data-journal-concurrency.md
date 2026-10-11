# Held-data journal concurrency: prototype deployment limits

The held-data prototype serializes journal appends and loss-evidence updates
with an atomic directory lock beside the journal. Startup, erasure deduplication,
and lifecycle status computation use the same lock. Without it, concurrent
writers can rename another writer's temporary evidence file, lower evidence
coverage, issue different erasure identifiers for concurrent retries, or compute
a positive status after another process acknowledges erasure.

This applies only to cooperating processes on one host. Every process that
writes the shared journal, including a lease issuer, must open a held-data
authority with the same canonical journal pathname and the same evidence file
before writing. The filesystem must support atomic directory creation and
rename, and file and directory fsync. The evidence file must remain outside the
journal's failure domain. A configuration without an epoch marker does not get
these guarantees. Replica mode and unregistered lease-only appends retain their
previous behavior. The feature flag remains off by default.

Lock acquisition has a thirty-second bound. Contention can block the Node event
loop, and the lock provides no fairness guarantee. A crashed process can leave
`<journal>.lock` behind. Do not remove it based on age or a guessed dead PID.
Stop every writer, establish the journal and evidence history, then remove the
lock before restarting. This patch does not add automatic recovery or make all
AS token, authentication, and owner-operation paths atomic.

`reference-implementation/test/held-data-concurrency.test.ts` runs three writer
threads with a concurrent status reader and checks exact entry membership,
terminal-event evidence coverage, status after acknowledgement, and truncation
detection. Separate barrier-controlled cases cover startup, duplicate erasure
requests, and the refresh-to-computation race. A fake elapsed-time clock tests
stale-lock refusal and explicit recovery. All five cases fail on `c312230212`.
These tests do not simulate power loss, partial writes, network filesystems, or
replacement of a journal with different content of equal or greater length.

The public DCR HTTP journey is covered in `test/held-data-as-e2e.test.ts` under
the reference implementation. Confidential DCR cannot reach lifecycle: the
registry accepts only `token_endpoint_auth_method=none` (`server/auth.ts`,
`SUPPORTED_CLIENT_AUTH_METHODS`). The test records HTTP 400
`invalid_client_metadata` for `private_key_jwt`. Existing confidential lifecycle
tests use CIMD. Supporting confidential DCR is a separate registration change.

Postgres selection affects the main AS database. The lifecycle authority stays
in the file journal, and the lease authority and credential stores stay in
SQLite (`lib/training-lease/authority-store.ts` and `credential-store.ts`).
Setting `PDPP_TEST_POSTGRES_URL` alone does not select Postgres for the HTTP
harness; `PDPP_STORAGE_BACKEND` and `PDPP_DATABASE_URL` select the backend.
Database tests require the dedicated loopback listener, a fresh database, and
the sentinel installed by `scripts/provision-test-database.ts`. Passing journal
or lease-store unit tests with those variables set is not Postgres coverage.

The HTTP fixture helper now updates the selected backend and requires an
affected row. Before this change, expiry and restore tests could update the
unused SQLite database while the AS read Postgres. Owner metadata uses
`jsonb_set` on Postgres and `json_set` on SQLite. The harness closes PostgreSQL
pools after the file finishes; leaving them open kept passing tests alive.
