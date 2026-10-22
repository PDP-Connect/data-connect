// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The explicit registry of which Postgres-backed test files may clone their
 * scratch database(s) from the per-run schema template
 * (scripts/postgres-test-template.ts) instead of paying a real, from-scratch
 * `initPostgresStorage` bootstrap.
 *
 * DEFAULT IS COLD. A file not listed in `POSTGRES_TEMPLATE_ELIGIBLE_FILES`
 * gets a cold, from-scratch bootstrap for every scratch database it creates
 * via `withTemporaryPostgresDatabase` or the per-file database `run-tests.ts`
 * allocates -- templating is opt-in per file, not opt-out. This is the
 * reviewer-required repair for the prior scheme, which defaulted every
 * shared-helper caller to the template and let cold-bootstrap, migration,
 * recovery, receipt, and deadlock authority tests silently skip the exact
 * code path they exist to exercise.
 *
 * A file earns a place on this list only when its own tests do not observe
 * or depend on schema being built from nothing -- they use Postgres as an
 * ordinary fixture for application-level behavior (routing, credential
 * state, EXPLAIN-plan index usage, ingest conformance, etc.), not as the
 * subject under test. See `test/postgres-template-eligibility-inventory.test.ts`
 * for the machine-checked half of this contract: every Postgres-profile test
 * file must appear on exactly one of this list or
 * `POSTGRES_TEMPLATE_COLD_REQUIRED_FILES`, and a cold-required file listed
 * here (or missing from both) fails the inventory test.
 */
export const POSTGRES_TEMPLATE_ELIGIBLE_FILES: readonly string[] = [
  "test/accepted-provider-native-consent.test.ts",
  "test/acknowledged-loss-store-postgres.test.ts",
  "test/active-run-summary-zero-spine.test.ts",
  "test/agent-cli.test.ts",
  "test/agent-connect-absent-only-expiry.test.ts",
  "test/approval-review-seam.test.ts",
  "test/auth-consent-device-postgres-path.test.ts",
  // Uses Postgres as a fixture for process-kill recovery of auth rows, not as the subject of schema bootstrap.
  "test/auth-kill-boundaries.test.ts",
  // Uses Postgres as a fixture for process-kill recovery of revocation cascades, not as the subject of schema bootstrap.
  "test/auth-revocation-atomicity.test.ts",
  "test/browser-surface-external-loss-receipt-atomicity.test.ts",
  "test/browser-surface-readiness-generation-atomicity.test.ts",
  "test/browser-surface-replacement-correction-artifact.test.ts",
  "test/browser-surface-replacement-ledger-store.test.ts",
  "test/checkpoint-dependency-profile-conformance-postgres.test.ts",
  "test/checkpoint-withhold-store.test.ts",
  "test/client-connector-postgres-path.test.ts",
  "test/client-event-subscription-store-postgres.test.ts",
  "test/compact-record-history.test.ts",
  "test/connector-attention-store.test.ts",
  // Exercises install, lock and post-install repair behavior over seeded data, not schema bootstrap.
  "test/connector-install-postgres.test.ts",
  "test/connector-instance-credential-revoke-postgres.test.ts",
  "test/connector-instance-delete-upsert-two-process-race.test.ts",
  "test/connector-instance-delete-vs-queued-write-fence.test.ts",
  "test/connector-instance-record-ingest-admission.test.ts",
  "test/connector-instance-revoked-write-refusal.test.ts",
  "test/connector-instance-writer-paths.test.ts",
  "test/connector-maintenance-cursor-postgres-race.test.ts",
  "test/connector-manifest-revision-fence.test.ts",
  "test/connector-summary-dirty-hooks.test.ts",
  "test/connector-summary-evidence-canonical-count-cancel-isolation.test.ts",
  "test/connector-summary-evidence-direct-write-source-revision-detection.test.ts",
  "test/connector-summary-evidence-engine-n-slope-postgres.test.ts",
  "test/connector-summary-evidence-fold-budget-resume.test.ts",
  "test/connector-summary-evidence-midloop-yield-postgres.test.ts",
  "test/connector-summary-evidence-scoped-fold-unrelated-terminal-history.test.ts",
  "test/connector-summary-evidence-scoped-route-n-slope.test.ts",
  "test/connector-summary-evidence-statement-timeout-swallow.test.ts",
  "test/connector-summary-evidence-throughput-integration.test.ts",
  "test/connector-summary-fold-fleet-scope-contamination.test.ts",
  "test/connector-summary-fold-page-scope-zero-history-reproduction.test.ts",
  "test/connector-summary-read-model.test.ts",
  "test/connector-summary-repair-backoff-postgres.test.ts",
  "test/connector-summary-repair-prescan-ordering-postgres.test.ts",
  "test/connector-summary-stream-facts-monotonic-postgres.test.ts",
  "test/connector-summary-stream-facts-reliability-postgres.test.ts",
  // Exercises challenge persistence, expiry, and single-use decisions, not schema bootstrap or migration.
  "test/consent-challenge-store-postgres-path.test.ts",
  "test/controller-browser-surface-leases-postgres.test.ts",
  "test/controller-phantom-active-run.test.ts",
  "test/credential-state-attribution-postgres.test.ts",
  "test/dataset-summary-postgres-boundary.test.ts",
  "test/detail-gap-recovered-race.test.ts",
  "test/device-batch-summary-evidence-convergence.test.ts",
  "test/device-enroll-postgres-admission-decoupling.test.ts",
  "test/device-exporter-postgres-proof.test.ts",
  "test/device-exporter-store-by-connector-scoped-ingest-outcome-summary.test.ts",
  "test/device-exporter-store.test.ts",
  "test/device-silence-postgres.test.ts",
  "test/device-ingest-attempt-context-store.test.ts",
  "test/device-ingest-conformance.test.ts",
  "test/direct-token-audit-atomicity-postgres.test.ts",
  "test/error-code-query-not-found.test.ts",
  "test/first-party-owner-credential-reuse.test.ts",
  "test/forward-evidence-debt-wired-probe.test.ts",
  "test/grant-lifecycle-expired-reporting.test.ts",
  "test/grant-scoped-state-postgres-routing.test.ts",
  "test/ingest-dirty-terminal-postgres-parity.test.ts",
  "test/introspection-manifest-fail-closed.test.ts",
  "test/legacy-profile-slack-run-postgres.test.ts",
  "test/legacy-upgrade-preservation-postgres.test.ts",
  "test/lexical-index-skip-unchanged-postgres.test.ts",
  "test/live-shadow-comparison.test.ts",
  // Postgres is a fixture for the newest state-commit read, not the schema bootstrap under test.
  "test/local-device-coverage-state-commit-postgres.test.ts",
  "test/manual-upload-artifact-store-postgres.test.ts",
  "test/oauth-code-delivery-atomicity.test.ts",
  "test/owner-connection-delete-orphans.test.ts",
  "test/owner-connection-revoke-credential-postgres.test.ts",
  "test/owner-device-approval-atomicity.test.ts",
  "test/owner-password-verifier.test.ts",
  "test/owner-session.test.ts",
  "test/owner-token-malformed-expiry.test.ts",
  "test/pairwise-as-context.test.ts",
  "test/physical-footprint-helper.test.ts",
  "test/polyfill-manifest-reconcile-bounded-work-postgres.test.ts",
  "test/postgres-bulk-lane-isolation.test.ts",
  "test/postgres-expand-hydration.test.ts",
  "test/postgres-lexical-backend-state.test.ts",
  "test/postgres-query-bounded.test.ts",
  // Live history pruning over seeded records; does not observe schema bootstrap.
  "test/postgres-record-prune-anchor.test.ts",
  "test/postgres-records-ingest-noop.test.ts",
  "test/postgres-records-version-floor.test.ts",
  "test/postgres-runtime-storage.test.ts",
  "test/postgres-semantic-existing-keys-bounded.test.ts",
  "test/postgres-stream-summary-grant-visibility.test.ts",
  "test/postgres-test-database-guard.test.ts",
  "test/postgres-transaction-connector-instance-lock.test.ts",
  "test/provider-app-config-store-postgres.test.ts",
  "test/reconcile-active-summary-evidence-oracle.test.ts",
  "test/reconcile-schedule-and-lifecycle-checkpoints.test.ts",
  "test/reconcile-summary-evidence-failure-persistence-postgres.test.ts",
  "test/record-expand-instance-authorization.test.ts",
  "test/record-field-window-substrate.test.ts",
  "test/record-rejection-store.test.ts",
  "test/record-reset-generation-checkpoint.test.ts",
  "test/record-version-stats.test.ts",
  "test/record-window-count-parity.test.ts",
  "test/records-delete-postgres-routing.test.ts",
  // Child processes ingest into a scratch database and are killed; does not observe schema bootstrap.
  "test/records-ingest-kill-durability.test.ts",
  // List pagination over seeded records on a scratch database; does not observe schema bootstrap.
  "test/records-null-cursor-pagination.test.ts",
  // Child processes ingest into a scratch database; does not observe schema bootstrap.
  "test/records-version-allocation-contention-postgres.test.ts",
  // Child processes tear down a seeded scratch database and are killed; does not observe schema bootstrap.
  "test/records-teardown-failure-matrix.test.ts",
  "test/recovery-bounded-reads.test.ts",
  // Quarantine compare-and-swap race over a seeded gap; does not observe schema bootstrap.
  "test/recovery-quarantine-race-postgres.test.ts",
  "test/ref-connectors-identity-inventory-profile.test.ts",
  "test/ref-connectors-identity-page-filter-explain.test.ts",
  "test/ref-connectors-identity-page-set-scope-explain.test.ts",
  "test/ref-connectors-list-connector-id-filter.test.ts",
  "test/ref-connectors-list-page-route-parity.test.ts",
  "test/ref-connectors-list-unbounded-scale.test.ts",
  "test/ref-connectors-record-corpus-independence.test.ts",
  "test/ref-connectors-retained-count-summary-profile.test.ts",
  "test/ref-connectors-retained-count-summary-route-parity.test.ts",
  "test/ref-source-webhook-route.test.ts",
  "test/retained-size-read-model.test.ts",
  "test/rs-explore-list-partitions-loose-scan.test.ts",
  "test/rs-explore-record-buckets.test.ts",
  "test/rs-explore-snapshot-at-capture-time.test.ts",
  "test/rs-explore-timeline-b1-b2-b3-regression.test.ts",
  "test/rs-explore-timeline-conformance.test.ts",
  "test/rs-explore-upcoming-concurrency.test.ts",
  "test/rs-explore-upcoming-reachability.test.ts",
  "test/rs-ingest-systemic-failure-contract.test.ts",
  "test/run-connection-identity-postgres.test.ts",
  "test/runtime-cancel-ingest-commit-boundary-probe.test.ts",
  "test/runtime-cursor-audit-fact.test.ts",
  "test/runtime-record-rejection-system-journey.test.ts",
  "test/scheduler-dispatch-wedge-health-reason.test.ts",
  "test/scheduler-owner-isolation.test.ts",
  "test/scheduler-store-reset-state-admission.test.ts",
  "test/scheduler-store-semantic-surface.test.ts",
  "test/search-index-lexical-resume.postgres.test.ts",
  "test/search-index-reconcile-scope-isolation.postgres.test.ts",
  "test/search-index-repair-correctness.postgres.test.ts",
  // Lexical cleanup debt over seeded rows; does not observe schema bootstrap.
  "test/search-reconcile-g1-postgres.test.ts",
  // Semantic cleanup debt over seeded vectors; does not observe schema bootstrap.
  "test/search-reconcile-g2-postgres.test.ts",
  "test/setup-binding-promotion.test.ts",
  "test/source-declaration-trust.test.ts",
  "test/source-field-name-records-parity.test.ts",
  "test/source-kind-runtime-neutrality.test.ts",
  "test/source-webhook-event-store.test.ts",
  "test/source-webhook-run-receipt.test.ts",
  "test/sources-visible-identity-page-postgres.test.ts",
  "test/storage-mode-startup-boundary.test.ts",
  "test/stream-evidence-run-registry-store-postgres.test.ts",
  "test/terminal-run-commit-collector-restart.test.ts",
  "test/terminal-run-commit-store-postgres.test.ts",
  "test/web-push-notifications.test.ts",
];

/**
 * Test files whose own tests directly exercise cold-bootstrap, migration
 * execution/ordering, crash recovery, receipt/evidence-tied-to-migration, or
 * deadlock-retry behavior on a from-scratch (or explicitly re-bootstrapped)
 * database. These files must NEVER resolve to the template path -- see the
 * inventory test for the fail-closed check.
 */
export const POSTGRES_TEMPLATE_COLD_REQUIRED_FILES: readonly string[] = [
  "test/absent-only-grant-expiry-postgres.test.ts",
  "test/backup-table-inventory-postgres.test.ts",
  "test/browser-surface-lease-store.test.ts",
  "test/connector-detail-gap-permanent-store.test.ts",
  "test/connector-detail-gap-store.test.ts",
  "test/connector-instance-store.test.ts",
  "test/connector-instances-status-draft-migration.test.ts",
  "test/connector-summary-evidence-canonical-count-repair-index.test.ts",
  "test/connector-summary-evidence-lifecycle-seq-index.test.ts",
  "test/connector-summary-source-revision.test.ts",
  "test/device-ingest-reservation-migration.test.ts",
  // Fences issuance writers while the cutover migration snapshots source tables.
  "test/issuance-cutover.test.ts",
  // Reopens old identity schemas and exercises migration rollback and recovery.
  "test/pairwise-grant-generation.test.ts",
  // Builds a prototype-shaped identity ledger before the real schema bootstrap.
  "test/pairwise-identity-foundation.test.ts",
  "test/polyfill-manifest-reconcile-invalidation-postgres.test.ts",
  "test/postgres-blob-publication-conflict.test.ts",
  "test/postgres-boot-migration-resume.test.ts",
  "test/postgres-bootstrap-deadlock-retry.test.ts",
  "test/postgres-derived-index-maintenance.test.ts",
  "test/postgres-hnsw-postlisten.test.ts",
  "test/postgres-orphan-blob-reclaim.test.ts",
  "test/postgres-record-index-bootstrap.test.ts",
  "test/postgres-record-index-idempotency-oracle.test.ts",
  "test/postgres-record-index-repair-oracle.test.ts",
  "test/postgres-semantic-pgvector.test.ts",
  // Verifies scope-index bootstrap identity and replacement of a bad definition.
  "test/postgres-semantic-scope-index-idempotence.test.ts",
  "test/postgres-template-eligibility-migration-mutation-control.test.ts",
  "test/records-instance-stream-id-keyset-index.test.ts",
  "test/rs-opaque-cursors.test.ts",
  "test/run-history-completed-at-fleet-migration.test.ts",
  "test/run-history-duplicate-run-id-identity.test.ts",
  "test/run-history-interrupted-migration-reconciliation.test.ts",
  "test/run-history-writer-authority.test.ts",
  "test/semantic-index-skip-unchanged-postgres.test.ts",
  // Exercises additive semantic input-identity migration and real publication.
  "test/semantic-startup-backfill-catches-crash-abandoned-record.test.ts",
  "test/spine-events-connector-instance-id-backfill.test.ts",
  "test/spine-source-boot-backfill.test.ts",
];

const ELIGIBLE_SET = new Set(POSTGRES_TEMPLATE_ELIGIBLE_FILES);
const COLD_REQUIRED_SET = new Set(POSTGRES_TEMPLATE_COLD_REQUIRED_FILES);

/** Normalize an absolute or relative filesystem path to its `test/...`-rooted repository-relative form. */
function toTestRelativePath(rawPath: string): string {
  const normalized = rawPath.replaceAll("\\", "/");
  if (normalized.includes("/test/")) {
    return `test/${normalized.split("/test/").at(-1)}`;
  }
  return normalized;
}

/**
 * Whether the given test file path is allowed to clone its scratch
 * database(s) from the per-run template. Cold (`false`) is the default for
 * any file not on the eligible list, including a file this registry has
 * never heard of.
 */
export function isPostgresTemplateEligibleFilePath(filePath: string): boolean {
  return ELIGIBLE_SET.has(toTestRelativePath(filePath));
}

/**
 * Whether the CURRENTLY RUNNING test file (identified by its own
 * `process.argv[1]`, which `scripts/run-tests.ts` spawns as exactly one file
 * per child process) is allowed to clone its scratch database(s) from the
 * per-run template.
 */
export function currentTestFileIsPostgresTemplateEligible(argv1: string | undefined = process.argv[1]): boolean {
  return argv1 !== undefined && isPostgresTemplateEligibleFilePath(argv1);
}

export function isPostgresTemplateColdRequired(relativePath: string): boolean {
  return COLD_REQUIRED_SET.has(relativePath);
}
