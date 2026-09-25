// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordData } from "./connector-runtime.ts";
import { type FingerprintCursor } from "./fingerprint-cursor.ts";
export type SourceClassification = "collect" | "collect_redacted" | "inventory_only" | "exclude" | "defer";
export type CoverageStatus = "collected" | "inventory_only" | "excluded" | "deferred" | "missing" | "unsupported";
export interface KnownLocalStore {
    classification: SourceClassification;
    reason: string;
    relativePath: string;
    store: string;
    stream: string | null;
}
export interface LocalCoverageStoreDescriptor {
    readonly store: string;
    readonly stream: string | null;
}
/**
 * The fixed local inventories are an authority shared by emitters and the
 * server proof reader. Keep identifiers here, separate from connector-specific
 * path/reason metadata, so a partial durable diagnostic set is detectable.
 */
export declare const LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR: {
    readonly claude_code: readonly [{
        readonly store: "projects";
        readonly stream: "sessions";
    }, {
        readonly store: "derived_messages";
        readonly stream: "messages";
    }, {
        readonly store: "derived_attachments";
        readonly stream: "attachments";
    }, {
        readonly store: "derived_memory_notes";
        readonly stream: "memory_notes";
    }, {
        readonly store: "skills";
        readonly stream: "skills";
    }, {
        readonly store: "commands";
        readonly stream: "slash_commands";
    }, {
        readonly store: "file_history";
        readonly stream: "file_history";
    }, {
        readonly store: "context_mode";
        readonly stream: null;
    }, {
        readonly store: "cache";
        readonly stream: "cache_inventory";
    }, {
        readonly store: "backups";
        readonly stream: "backup_inventory";
    }, {
        readonly store: "config";
        readonly stream: "config_inventory";
    }, {
        readonly store: "auth";
        readonly stream: null;
    }];
    readonly codex: readonly [{
        readonly store: "sessions";
        readonly stream: "sessions";
    }, {
        readonly store: "sessions_archive";
        readonly stream: "sessions";
    }, {
        readonly store: "state_db";
        readonly stream: "sessions";
    }, {
        readonly store: "derived_messages";
        readonly stream: "messages";
    }, {
        readonly store: "derived_function_calls";
        readonly stream: "function_calls";
    }, {
        readonly store: "rules";
        readonly stream: "rules";
    }, {
        readonly store: "prompts";
        readonly stream: "prompts";
    }, {
        readonly store: "skills";
        readonly stream: "skills";
    }, {
        readonly store: "history";
        readonly stream: "history";
    }, {
        readonly store: "session_index";
        readonly stream: "session_index";
    }, {
        readonly store: "shell_snapshots";
        readonly stream: "shell_snapshots";
    }, {
        readonly store: "memories";
        readonly stream: null;
    }, {
        readonly store: "context_mode";
        readonly stream: null;
    }, {
        readonly store: "config";
        readonly stream: "config_inventory";
    }, {
        readonly store: "cache";
        readonly stream: "cache_inventory";
    }, {
        readonly store: "auth";
        readonly stream: null;
    }];
    readonly google_takeout: readonly [{
        readonly store: "location_history";
        readonly stream: "location_history";
    }, {
        readonly store: "youtube_watch_history";
        readonly stream: "youtube_watch_history";
    }, {
        readonly store: "search_history";
        readonly stream: "search_history";
    }, {
        readonly store: "photos";
        readonly stream: "photos";
    }];
    readonly apple_photos: readonly [{
        readonly store: "export_dir";
        readonly stream: "photos";
    }];
    readonly google_messages: readonly [{
        readonly store: "gmcli_archive";
        readonly stream: "messages";
    }];
};
type LocalCoverageStoreNamesByConnector = {
    readonly [K in keyof typeof LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR]: readonly string[];
};
/** Compatibility store-name view of the exact descriptor authority. */
export declare const LOCAL_COVERAGE_STORES_BY_CONNECTOR: LocalCoverageStoreNamesByConnector;
export type LocalCoverageConnector = keyof typeof LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR;
export declare function expectedLocalCoverageStores(connectorId: string): readonly string[] | null;
export declare function expectedLocalCoverageStoreDescriptors(connectorId: string): readonly LocalCoverageStoreDescriptor[] | null;
/**
 * Every manifest stream the server proof reader (`deriveLocalCoverageAxis`,
 * via `parseCoverageDiagnosticsStateSnapshot`) must be able to prove complete
 * needs at least one descriptor mapped to it, or that stream is structurally
 * uncappable regardless of what the connector's emitter actually collects —
 * exactly the drift this authority table exists to make detectable instead of
 * silent (see the table's own doc comment above). A required stream missing a
 * descriptor is reported so a connector-package-owned conformance test can
 * fail on it without either package reaching into the other's internals.
 */
export declare function localCoverageStreamsMissingDescriptors(connectorId: string, requiredStreams: readonly string[]): readonly string[];
export interface InventoryRecord extends RecordData {
    classification: "inventory_only" | "defer";
    id: string;
    mtime_epoch: number | null;
    path_hash: string;
    reason: string;
    relative_path: string;
    size_bytes: number | null;
    store: string;
    type: "directory" | "file" | "missing" | "other";
}
export interface CoverageRecord extends RecordData {
    id: string;
    reason: string;
    /**
     * `"unaccounted"` alongside the closed {@link CoverageStatus} set: reserved
     * (see `COLLECTOR_COVERAGE_STATUSES` in collector-runner.ts) for a
     * connector-derived coverage record that could not classify a discovered
     * store — e.g. a rollout scan that failed before it could examine
     * anything. Never returned by `coverageStatus()`'s static classification.
     */
    status: CoverageStatus | "unaccounted";
    store: string;
    stream: string | null;
}
export interface SafeCoverageDiagnosticStore {
    /**
     * Boundary this store's coverage was measured under, carried through the
     * durable snapshot so the read side can tell coverage-of-a-declared-region
     * from coverage-of-everything. Absent for a snapshot written before the scope
     * contract, which is a different claim from `unscoped` and must stay
     * distinguishable.
     */
    readonly collection_scope?: string;
    readonly status: CoverageStatus | "unaccounted";
    readonly store: string;
    readonly stream: string | null;
}
/**
 * Construct the only durable positive local-coverage proof. It deliberately
 * strips record ids and reason/path-derived metadata at the producer boundary.
 */
export declare function buildCoverageDiagnosticsStateSnapshot(coverage: readonly CoverageRecord[]): readonly SafeCoverageDiagnosticStore[];
/**
 * Human-readable `reason` for a derived coverage_diagnostics record — one
 * whose stream has no dedicated top-level `KnownLocalStore` entry because it
 * is parsed out of the same on-disk source as another, already-scanned
 * stream (e.g. Claude Code's `messages`/`attachments`/`memory_notes` and
 * Codex's `messages`/`function_calls`, both derived from the same session
 * transcripts their connector also scans for `sessions`).
 *
 * `incompleteReason` lets a connector supply its own scan-outcome detail
 * (e.g. "rollout enumeration failed: unreadable" vs "...: parse_error") for
 * the `!scanComplete` case; the generic fallback is used when omitted.
 */
export declare function describeDerivedCoverageReason(input: {
    emitted: number;
    examined: number;
    incompleteReason?: string | undefined;
    label: string;
    scanComplete: boolean;
}): string;
/**
 * A derived `coverage_diagnostics` {@link CoverageRecord} for one stream that
 * is parsed out of another stream's already-scanned source rather than its
 * own `KnownLocalStore` entry, so it would otherwise never earn a coverage
 * row and would silently vanish from `collection_facts`/`fullyAccounted`
 * despite emitting real records (see collector-runner.ts's
 * `buildTerminalCollectionFacts`/`summarizeCollectorCompleteness`, which only
 * ever see streams with at least one coverage row).
 *
 * On the canonical coverage-status vocabulary ({@link CoverageStatus} |
 * `"unaccounted"`): a scan that completed — even examining zero records — is
 * `collected` (the `reason` carries the zero/positive detail); a scan that
 * never ran to completion is `unaccounted`, since the connector cannot
 * classify what it never got to examine.
 *
 * This is pure mechanical policy shared across connectors. Enumeration,
 * `label` wording, counting, and mapping a connector's own scan-outcome type
 * onto `scanComplete`/`incompleteReason` all stay connector-specific. The
 * store id and record id are NOT connector-specific inputs -- see
 * {@link selectLocalCoverageDerivedDescriptor}: the authority table selects
 * them, so an emitter cannot report a derived stream under a store id the
 * table doesn't declare.
 */
export declare function buildDerivedCoverageRecord(input: {
    connectorId: string;
    emitted: number;
    examined: number;
    incompleteReason?: string | undefined;
    label: string;
    scanComplete: boolean;
    scopeFingerprint?: string;
    stream: string;
}): CoverageRecord;
/**
 * Resolve the ONE descriptor the authority table declares for a derived
 * stream -- the structural link that makes it impossible for a connector's
 * `emitDerivedCoverage` to report a store id the table doesn't know about.
 * Throws (fails loud, at the point the drift would happen) when the
 * connector has no authoritative inventory, when no descriptor maps to this
 * stream, or when more than one does (ambiguous -- e.g. `codex`'s `sessions`
 * stream is deliberately mapped by two static stores, `sessions` and
 * `state_db`, so a derived-stream caller for `sessions` would be an error,
 * not a silent pick).
 */
export declare function selectLocalCoverageDerivedDescriptor(connectorId: string, stream: string): LocalCoverageStoreDescriptor;
export interface ParsedCoverageDiagnosticsStateSnapshot {
    readonly duplicateStores: readonly string[];
    readonly hasAuthoritativeInventory: boolean;
    readonly hasCommittedSnapshot: boolean;
    readonly malformed: boolean;
    readonly missingStores: readonly string[];
    readonly rows: readonly SafeCoverageDiagnosticStore[];
    readonly unexpectedStores: readonly string[];
}
/**
 * Parse the committed coverage STATE at its trust boundary. Only the current
 * `{ fetched_at, stores }` schema and its exact safe store triples are proof;
 * legacy, private, and future-shaped state fails closed as malformed.
 */
export declare function parseCoverageDiagnosticsStateSnapshot(connectorId: string, state: unknown): ParsedCoverageDiagnosticsStateSnapshot;
export interface InventoryPlan {
    coverage: CoverageRecord[];
    recordsByStream: Map<string, InventoryRecord[]>;
}
export declare function buildLocalSourceInventory(tool: string, sourceHome: string, stores: readonly KnownLocalStore[],
/**
 * Fingerprint of the boundary this run enumerated under, stamped onto every
 * coverage record.
 *
 * It rides on the RECORDS rather than a side channel because the records are
 * the coverage evidence: they commit together in the same ingest batch, so a
 * crash between steps can never pair one run's coverage rows with another
 * run's boundary, and there is no second store to fall out of sync. A reader
 * takes the fingerprint from the same rows it is already reading -- one read,
 * no extra query, identical on both backends.
 */
collectionScope?: string | null): Promise<InventoryPlan>;
export declare function listDirectoryInventory(input: {
    reason: string;
    relativeRoot: string;
    sourceHome: string;
    store: string;
    stream: string;
    tool: string;
}): Promise<InventoryRecord[]>;
/** Payload keys excluded from inventory-record change detection. Incidental
 *  file-stat metadata that moves on every tool write without changing the
 *  store's inventory meaning. Mirrored by the compaction policy in
 *  `reference-implementation/scripts/compact-record-history.ts`. */
export declare const INVENTORY_FINGERPRINT_EXCLUDE_KEYS: readonly ["mtime_epoch", "size_bytes"];
/** Open a fingerprint cursor for an inventory stream, seeded from the prior
 *  STATE cursor. Excludes the incidental `mtime_epoch`/`size_bytes` file-stat
 *  fields so an unchanged store does not re-version on every run. Inventory
 *  enumeration is a full scan of the known stores under the source home, so
 *  callers SHOULD `dropUnseenIds()` before serializing STATE: a store that
 *  disappears must drop out of the cursor so its re-appearance re-emits. */
export declare function openInventoryFingerprintCursor(priorState: unknown): FingerprintCursor;
export {};
//# sourceMappingURL=local-source-inventory.d.ts.map