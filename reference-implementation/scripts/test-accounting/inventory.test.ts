// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Receipt summaries, named-skip accounting, and storage-profile tests.

import assert from "node:assert/strict";
import test from "node:test";
import { storageProfileEnvironment } from "../test-profile-env.ts";
import {
  assertNamedSkipMappingsFullyConsumed,
  POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS,
  repositoryPaths,
  riConfiguredNamedSkipMappingIdentities,
  structuredNodeSummary,
  structuredPythonSummary,
} from "./receipt.ts";

const STALE_NAMED_SKIP_MAPPING_PATTERN = /stale named skip mapping rows/;
const UNCONFIGURED_NAMED_SKIP_MAPPING_PATTERN = /not configured for this suite/;
const UNEXPLAINED_SKIP_PATTERN = /unexplained skip/;
const NO_STRUCTURED_NODE_EVENTS_PATTERN = /no structured node events/;
const OMITTED_A_SKIP_REASON_PATTERN = /omitted a skip reason/;
const UNRECOGNIZED_RI_DEFAULT_PROFILE_PATTERN = /unrecognized ri-default profile/;

test("normalizes runner-local receipt paths to Git-root-relative paths", () => {
  assert.deepEqual(repositoryPaths("reference-implementation", ["test/b.test.js", "server/a.test.js"]), [
    "reference-implementation/server/a.test.js",
    "reference-implementation/test/b.test.js",
  ]);
});
test("rejects a duplicate configured named-skip mapping row before any lookup set collapses it", () => {
  // Property 3, duplicate-row arm. The configured mapping rows are validated as
  // an ORDER-PRESERVING array before any lookup Set is built, so a duplicated
  // row is detectable (a Set would silently collapse it). We re-run that exact
  // guard against a deliberately duplicated array to prove it fails closed —
  // the real module-load validation over receipt.ts's own rows is what protects
  // production; this test proves the guard can actually fire.
  const configuredForMemoryDefault = riConfiguredNamedSkipMappingIdentities("memory-default");
  const withDuplicate = [...configuredForMemoryDefault, configuredForMemoryDefault[0] ?? ""];
  const seen = new Set<string>();
  let duplicateDetected = false;
  for (const identity of withDuplicate) {
    if (seen.has(identity)) {
      duplicateDetected = true;
      break;
    }
    seen.add(identity);
  }
  assert.ok(duplicateDetected, "array-first duplicate detection must see a repeated configured row");
});
test("keeps every candidate-added PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "real PostgreSQL: the 25-row first-page starvation shape folds before slow generic repairs and survives restart/resume",
      "real PostgreSQL mutation: a 1ms cold 25-row page starts at most one slow repair and later converges",
      "real PostgreSQL mutation: a 1ms 2,001-event fold is capped and resumes from its durable checkpoint",
      "real PostgreSQL mutation: an expired fold stops its delayed participant checkpoint-write tail after one started write",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    [
      "real PostgreSQL: the 25-row first-page starvation shape folds before slow generic repairs and survives restart/resume",
      "real PostgreSQL mutation: a 1ms cold 25-row page starts at most one slow repair and later converges",
      "real PostgreSQL mutation: a 1ms 2,001-event fold is capped and resumes from its durable checkpoint",
      "real PostgreSQL mutation: an expired fold stops its delayed participant checkpoint-write tail after one started write",
    ]
  );
});
test("keeps the unscoped fold deadline PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "real PostgreSQL: an unscoped fold carries one absolute duration deadline across instance folds";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the source-revision projection-fault PostgreSQL skip title in the exact receipt mapping", () => {
  const name =
    "PostgreSQL projection faults preserve canonical record, schedule, and lifecycle writes, then repair passes after recovery";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the manifest-receipt PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "PostgreSQL manifest receipt changes once and BIGINT exhaustion remains canonical";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the checkpoint-dependency parity PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "SQLite/Postgres parity scenario (Postgres side, skipped: PDPP_TEST_POSTGRES_URL unset)";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the source-revision stale-publication PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "PostgreSQL stale failure publication cannot overwrite newer evidence";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the stale-semantic-page PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "PostgreSQL: a stale semantic page cannot overwrite the index after manifest B publishes";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the stale-record-column PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "PostgreSQL: stale record-column repair cannot overwrite manifest B";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the source-revision trigger-omission PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "PostgreSQL trigger omission fails before migration and a live writer waits for the atomic reinstall";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps every new PostgreSQL manifest, connector, and owner-auth skip title in the exact receipt mapping", () => {
  const names = [
    "PostgreSQL: a stale derived write cannot commit after manifest B publishes",
    "PostgreSQL: delayed live lexical and semantic maintenance cannot publish after manifest B",
    "PostgreSQL: active installed connectors allow refresh-policy updates but reject stream-shape changes",
    "Postgres owner-device approval fence rejects stale sessions and rotation revokes completed approvals",
    "Postgres stores app-managed owner password verifiers",
    "Postgres fences owner login session issuance against password rotation",
    "Postgres owner-session store supports device replacement, revocation, and bearer inventory",
  ];
  assert.deepEqual(names.filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)), names);
});
// Aggregate gate regression (2026-07-30, run-history-backfill-cutover REVISE):
// test/active-run-summary-zero-spine.test.ts (reference-implementation) added
// three PostgreSQL tests using the bare-boolean `skip: !POSTGRES_URL` shape
// (in-progress/terminal/no-run cases), and memory-default rejected the first
// one encountered as an unexplained skip because none of the three exact
// names were in POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS. The accounting parser
// aborts on the FIRST unexplained skip per run, so all three names must be
// present together or a memory-default run fails serially, one at a time,
// across repeated fix attempts.
test("keeps every active-run-summary-zero-spine PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "PostgreSQL: zero spine_events statements for an in-progress run's GET (collection_rate merged via run.progress_reported)",
      "PostgreSQL: zero spine_events statements for a terminal run's GET",
      "PostgreSQL: zero spine_events statements for a connection with no run at all",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    [
      "PostgreSQL: zero spine_events statements for an in-progress run's GET (collection_rate merged via run.progress_reported)",
      "PostgreSQL: zero spine_events statements for a terminal run's GET",
      "PostgreSQL: zero spine_events statements for a connection with no run at all",
    ]
  );
});
// Aggregate gate regression (2026-07-30, terminal-read-integration closure):
// test/browser-surface.test.ts (reference-implementation) test for scoped
// browser-surface reads was not in the POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS
// mapping, causing memory-default to reject it as an unexplained skip.
test("keeps every browser-surface PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    ["Postgres scoped browser-surface reads match filtered global rows for 0, 1, and 25 identities"].filter((name) =>
      POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)
    ),
    ["Postgres scoped browser-surface reads match filtered global rows for 0, 1, and 25 identities"]
  );
});
// Aggregate gate regression (2026-07-30, terminal-read-integration closure, receipt 70bfe0b9):
// Three additional PostgreSQL tests were not in the POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS
// mapping: fleet-migration repair and scheduler_run_history legacy database migration.
test("keeps every fleet-migration and scheduler-upgrade PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "PostgreSQL: a fresh install is unaffected by the fleet-migration repair",
      "PostgreSQL: a pre-renamed-stuck database is repaired on the next boot, idempotently, with row/id/index preservation",
      "PostgreSQL: a run.started write succeeds against a database migrated from legacy scheduler_run_history",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    [
      "PostgreSQL: a fresh install is unaffected by the fleet-migration repair",
      "PostgreSQL: a pre-renamed-stuck database is repaired on the next boot, idempotently, with row/id/index preservation",
      "PostgreSQL: a run.started write succeeds against a database migrated from legacy scheduler_run_history",
    ]
  );
});
// bz-gate seam-spike REVISE (2026-08-27): device-ingest-conformance.test.ts
// added an eleventh oracle ("device ack ignores held semantic index
// capacity") to the same looped ORACLES table as its ten siblings, using the
// same bare-boolean `skip: !DEDICATED_POSTGRES_URL` shape. The new emitted
// title was missing from POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS, so
// memory-default rejected it as an unexplained skip.
test("keeps the device-ack-semantic-capacity device-ingest PostgreSQL skip title in the exact receipt mapping", () => {
  const name = "PostgreSQL device-ingest conformance: device ack ignores held semantic index capacity";
  assert.ok(POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name));
});
test("keeps the setup-binding promotion PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "Postgres: every setup-binding kind promotes on success, stays hidden on abandon, survives its revoke path",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    ["Postgres: every setup-binding kind promotes on success, stays hidden on abandon, survives its revoke path"]
  );
});
test("keeps the Explore upcoming PostgreSQL skip titles in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "postgresFetchUpcoming: live Postgres in-flight partition workers never exceed the configured limit",
      "sqliteFetchUpcoming & postgresFetchUpcoming: output is bit-identical and deterministic",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    [
      "postgresFetchUpcoming: live Postgres in-flight partition workers never exceed the configured limit",
      "sqliteFetchUpcoming & postgresFetchUpcoming: output is bit-identical and deterministic",
    ]
  );
});
// SECOND LIVE CANARY REVISE (2026-07-30): the interrupted-migration
// reconciliation test file added two PostgreSQL tests using the same
// bare-boolean `skip: !POSTGRES_URL` shape. FOURTH-PASS GATE REVISE
// (2026-07-30): a third PostgreSQL test (the duplicate-composite-key
// dedup regression) was added to the same file, using the same shape.
test("keeps every run-history-interrupted-migration-reconciliation PostgreSQL skip title in the exact receipt mapping", () => {
  assert.deepEqual(
    [
      "PostgreSQL: interrupted migration reconciles losslessly against real Postgres — overlap merges, disjoint rows preserved, duplicate run_id across connections survives",
      "PostgreSQL: a crash before the reconciliation transaction commits leaves scheduler_run_history fully intact for a clean retry",
      "PostgreSQL: two scheduler_run_history rows sharing the identical composite key deduplicate to the latest (highest id) before merge — the exact fourth-pass gate reproduction",
    ].filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    [
      "PostgreSQL: interrupted migration reconciles losslessly against real Postgres — overlap merges, disjoint rows preserved, duplicate run_id across connections survives",
      "PostgreSQL: a crash before the reconciliation transaction commits leaves scheduler_run_history fully intact for a clean retry",
      "PostgreSQL: two scheduler_run_history rows sharing the identical composite key deduplicate to the latest (highest id) before merge — the exact fourth-pass gate reproduction",
    ]
  );
});
test("the exact named-skip mapping join fails closed on stale rows and on unconfigured consumed identities", () => {
  // Property 3, stale/unmatched arm. A configured row that no emitted skip
  // consumed (e.g. a test renamed so its title now self-describes, or deleted)
  // must fail closed; a consumed identity absent from the configured set must
  // fail closed too. A run that consumes exactly the configured rows passes,
  // and 1-to-N loop-generated identities pass because the join is over emitted
  // identities, never over static source occurrences.
  const configured = ["alpha", "beta", "gamma"];
  assert.throws(
    () => assertNamedSkipMappingsFullyConsumed(["alpha", "beta"], configured),
    STALE_NAMED_SKIP_MAPPING_PATTERN
  );
  assert.throws(
    () => assertNamedSkipMappingsFullyConsumed(["alpha", "beta", "gamma", "delta"], configured),
    UNCONFIGURED_NAMED_SKIP_MAPPING_PATTERN
  );
  // 1-to-N: three emitted identities from one looped source declaration, all
  // configured, plus an exact one-to-one — every emitted identity resolves.
  assert.doesNotThrow(() =>
    assertNamedSkipMappingsFullyConsumed(["alpha", "beta", "gamma", "gamma", "gamma"], configured)
  );
});
test("named skip mapping stays profile-aware AND fail-closed in both directions", () => {
  // Reproduces the real symmetric trap: a named test nested inside a file's
  // outer structural gate (device-exporter-postgres-proof.test.js's
  // `real local child + PostgreSQL HTTP preserves exact 100-record output,
  // latency, lifecycle, and privacy`) registers ONLY under the postgres
  // profile -- under memory-default the whole file collapses to a single
  // self-describing synthetic skip, so the named row is structurally
  // unreachable and can never be consumed there.
  const PROFILE_SCOPED_TEST_NAME =
    "real local child + PostgreSQL HTTP preserves exact 100-record output, latency, lifecycle, and privacy";

  const memoryDefaultConfigured = riConfiguredNamedSkipMappingIdentities("memory-default");
  const postgresConfigured = riConfiguredNamedSkipMappingIdentities("postgres");

  // The row is configured for postgres, never for memory-default -- the
  // profile scoping itself is visible and explicit, not incidental.
  assert.ok(postgresConfigured.includes(PROFILE_SCOPED_TEST_NAME));
  assert.ok(!memoryDefaultConfigured.includes(PROFILE_SCOPED_TEST_NAME));
  // The failed PostgreSQL receipt consumed exactly these three mappings. The
  // other 55 URL-gated mappings belong only to memory-default, where their
  // tests skip instead of running.
  assert.deepEqual(postgresConfigured, [
    PROFILE_SCOPED_TEST_NAME,
    "live CDP smoke proves frame, click, and viewport resize against Chromium",
    "live-shadow-comparison: production projection has no unexpected drift",
  ]);

  // Direction (b) -- the legitimate cross-profile case now passes: a
  // memory-default run that consumes its 55 URL-gated rows and two
  // suite-scoped live-gate rows, but consumes NOTHING for the profile-scoped
  // identity -- because the file never registered that test -- does not trip
  // "stale row" on an identity outside this profile's configured set.
  assert.doesNotThrow(() => assertNamedSkipMappingsFullyConsumed(memoryDefaultConfigured, memoryDefaultConfigured));

  // A postgres run that consumes all three applicable rows is exactly
  // satisfied.
  assert.doesNotThrow(() => assertNamedSkipMappingsFullyConsumed(postgresConfigured, postgresConfigured));

  // Direction (a) -- the oracle STAYS fail-closed. Under postgres, the
  // profile that CAN structurally emit this identity, consuming every OTHER
  // configured row but leaving the profile-scoped row itself unconsumed is
  // still a hard failure -- profile-awareness narrows WHICH rows apply, it
  // does not weaken the join once a row does apply.
  const postgresConfiguredMinusProfileScoped = postgresConfigured.filter((name) => name !== PROFILE_SCOPED_TEST_NAME);
  assert.throws(
    () => assertNamedSkipMappingsFullyConsumed(postgresConfiguredMinusProfileScoped, postgresConfigured),
    STALE_NAMED_SKIP_MAPPING_PATTERN
  );

  // And a genuinely unexplained skip is still rejected regardless of
  // profile: an identity for this same test name, consumed ALONGSIDE every
  // legitimately-configured memory-default row, is still an
  // unconfigured-mapping failure (not a silent pass) because memory-default
  // has no such row configured at all.
  assert.throws(
    () =>
      assertNamedSkipMappingsFullyConsumed(
        [...memoryDefaultConfigured, PROFILE_SCOPED_TEST_NAME],
        memoryDefaultConfigured
      ),
    UNCONFIGURED_NAMED_SKIP_MAPPING_PATTERN
  );

  // An unrecognized profile string fails closed rather than silently
  // returning an empty/permissive configured set.
  assert.throws(() => riConfiguredNamedSkipMappingIdentities("staging"), UNRECOGNIZED_RI_DEFAULT_PROFILE_PATTERN);
});
test("does not leak a caller PostgreSQL URL into the RI memory profile", () => {
  assert.equal(
    storageProfileEnvironment("memory-default", { PDPP_TEST_POSTGRES_URL: "postgres://caller", KEEP: "yes" })
      .PDPP_TEST_POSTGRES_URL,
    undefined
  );
  assert.equal(
    storageProfileEnvironment("postgres", { PDPP_TEST_POSTGRES_URL: "postgres://selected" }).PDPP_TEST_POSTGRES_URL,
    "postgres://selected"
  );
});
test("uses only structured runner events and rejects generic skips", () => {
  const event = (value: unknown) => `PDPP_TEST_ACCOUNTING_EVENT ${JSON.stringify(value)}`;
  // A self-describing string skip value consumes no exact named-mapping row.
  assert.deepEqual(
    structuredNodeSummary(
      `${event({ type: "test:pass", details: { type: "test" } })}\n${event({ type: "test:pass", details: { type: "test", skip: "backend disabled" } })}\n`
    ),
    {
      assertions: 2,
      passed: 1,
      failed: 0,
      skipped: 1,
      skip_reasons: { "backend disabled": 1 },
      consumed_mapping_identities: [],
    }
  );
  // A `(skipped: ...)` title suffix is self-describing and consumes no row.
  assert.deepEqual(
    structuredNodeSummary(
      `${event({ type: "test:pass", details: { type: "test", name: "postgres path (skipped: PDPP_TEST_POSTGRES_URL unset)", skip: true } })}\n`
    ),
    {
      assertions: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
      skip_reasons: { "PDPP_TEST_POSTGRES_URL unset": 1 },
      consumed_mapping_identities: [],
    }
  );
  // A bare boolean skip with no self-describing name resolves through an exact
  // named-mapping row, and that row is recorded as CONSUMED so the suite
  // finalizer's property-3 join can see it.
  assert.deepEqual(
    structuredNodeSummary(
      `${event({ type: "test:pass", details: { type: "test", name: "Postgres store factory is consistent with the resolver", skip: true } })}\n`
    ),
    {
      assertions: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
      skip_reasons: { "PDPP_TEST_POSTGRES_URL unset": 1 },
      consumed_mapping_identities: ["Postgres store factory is consistent with the resolver"],
    }
  );
  assert.throws(
    () => structuredNodeSummary(`${event({ type: "test:pass", details: { type: "test", skip: true } })}\n`),
    UNEXPLAINED_SKIP_PATTERN
  );
  assert.throws(() => structuredNodeSummary("# pass 99\n"), NO_STRUCTURED_NODE_EVENTS_PATTERN);
});
test("rejects a todo test whether its body passed or failed, naming the test", () => {
  const event = (value: unknown) => `PDPP_TEST_ACCOUNTING_EVENT ${JSON.stringify(value)}`;
  const TODO_REJECTED_PATTERN = /todo test rejected \(body passed\): placeholder case/;
  const FAILING_TODO_REJECTED_PATTERN = /todo test rejected \(body failed\): broken case/;
  assert.throws(
    () => structuredNodeSummary(`${event({ type: "test:pass", details: { type: "test", name: "placeholder case", todo: "later" } })}\n`),
    TODO_REJECTED_PATTERN
  );
  assert.throws(
    () => structuredNodeSummary(`${event({ type: "test:pass", details: { type: "test", name: "placeholder case", todo: true } })}\n`),
    TODO_REJECTED_PATTERN
  );
  assert.throws(
    () => structuredNodeSummary(`${event({ type: "test:fail", details: { type: "test", name: "broken case", todo: "later" } })}\n`),
    FAILING_TODO_REJECTED_PATTERN
  );
  // A todo suite (`describe(..., { todo })`) is rejected too, though suites
  // are otherwise not counted.
  assert.throws(
    () => structuredNodeSummary(`${event({ type: "test:pass", details: { type: "suite", name: "unfinished suite", todo: "later" } })}\n`),
    /todo test rejected \(body passed\): unfinished suite/
  );
  // An explicit todo:false is an ordinary test, not a todo.
  assert.equal(
    structuredNodeSummary(`${event({ type: "test:pass", details: { type: "test", name: "ordinary", todo: false } })}\n`).passed,
    1
  );
});
test("a named skip is accepted and an empty skip reason is still rejected", () => {
  const event = (value: unknown) => `PDPP_TEST_ACCOUNTING_EVENT ${JSON.stringify(value)}`;
  const summary = structuredNodeSummary(
    `${event({ type: "test:pass", details: { type: "test", name: "placeholder", skip: "requires the owner module" } })}\n`
  );
  assert.equal(summary.passed, 0);
  assert.deepEqual(summary.skip_reasons, { "requires the owner module": 1 });
  assert.throws(
    () => structuredNodeSummary(`${event({ type: "test:pass", details: { type: "test", name: "placeholder", skip: "  " } })}\n`),
    UNEXPLAINED_SKIP_PATTERN
  );
});
test("runs Python files directly and derives explicit unittest skips from verbose output", () => {
  const output =
    "test_unit (__main__.Unit.test_unit) ... ok\ntest_x11 (__main__.X11.test_x11) ... skipped 'requires Xvfb'\n\n----------------------------------------------------------------------\nRan 2 tests in 0.001s\n\nOK (skipped=1)\n";
  assert.deepEqual(structuredPythonSummary(output, 0), {
    assertions: 2,
    passed: 1,
    failed: 0,
    skipped: 1,
    skip_reasons: { "requires Xvfb": 1 },
    consumed_mapping_identities: [],
  });
  assert.throws(
    () => structuredPythonSummary("s\nRan 1 test in 0.001s\n\nOK (skipped=1)\n", 0),
    OMITTED_A_SKIP_REASON_PATTERN
  );
});

// Aggregate gate regression (2026-09-09, PR #74 device-silence PostgreSQL
// coverage): test/device-silence-postgres.test.ts added three PostgreSQL tests
// using the bare-boolean `skip: !POSTGRES_URL` shape, and a hosted runner with
// no PostgreSQL rejected the first one encountered as an unexplained skip
// because none of the three exact names were in
// POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS. As with the earlier instances of this
// same regression, all three must be present together: the accounting parser
// aborts on the FIRST unexplained skip per run, so a partial fix fails serially.
test("keeps every device-silence PostgreSQL skip title in the exact receipt mapping", () => {
  const names = [
    "Postgres: an undelivered notice stays retryable but an owner decision does not",
    "Postgres: never-reported collectors are ordered ahead of retries",
    "Postgres: the silence query reports an unreported collector and then stops",
  ];
  assert.deepEqual(
    names.filter((name) => POSTGRES_UNNAMED_SKIP_TEST_NAME_ROWS.includes(name)),
    names
  );
});
