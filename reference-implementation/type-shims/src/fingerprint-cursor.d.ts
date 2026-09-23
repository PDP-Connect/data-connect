import type { RecordData } from "@pdpp/connector-protocol";
export interface CarryForwardCursor<T> {
    /** Drop ids from the next map that were not `note`d this run. Idempotent.
     *  Only valid on full-scan streams: a partial scan has no business
     *  pruning ids it never looked at. If `note` was called zero times this
     *  run, every prior id is dropped — the correct outcome for a requested
     *  full-scan stream that returned zero records. */
    dropUnseenIds: () => void;
    /** Record this id's fingerprint into the next-run map and the seen-set.
     *  Carry-forward and prune both depend on every observed id passing
     *  through here, even when the connector decides not to emit the record. */
    note: (id: string, value: T) => void;
    /** Prior cursor value for this id, if any. Connector change-detection
     *  rules and derived-field-preservation policies read this. The value is
     *  the prior run's serialized fingerprint, never the one `note` recorded
     *  this run. */
    prior: (id: string) => T | undefined;
    /** Number of ids in the next map. */
    size: () => number;
    /** Serializable next-run map for STATE. */
    toState: () => Record<string, T>;
}
/** Open a typed carry-forward cursor seeded from a pre-decoded prior map.
 *
 *  Unlike `openFingerprintCursor`, this does not decode a STATE shape or
 *  compute fingerprints — the caller owns both, because the fingerprint
 *  type and its on-disk shape are connector-specific. The cursor only owns
 *  the seed/seen/prune/serialize lifecycle.
 *
 *  The next map is seeded by copying the prior map, so a record the caller
 *  declines to `note` this run still surfaces in `toState()`. */
export declare function openCarryForwardCursor<T>(prior: ReadonlyMap<string, T>): CarryForwardCursor<T>;
export interface FingerprintCursorOptions {
    /** Fields that appear in the emitted record but must NOT participate in
     *  change detection. Typically run-clock fields like `fetched_at` whose
     *  value is "when this run happened" rather than "when the source row
     *  changed". Without exclusion, the fingerprint would never match across
     *  runs even when the source has not moved. */
    excludeFromFingerprint?: readonly string[];
    /** Optional pre-decoded prior fingerprint map. Use this when the caller
     *  has already pulled the map out of a non-standard cursor shape. If
     *  omitted, the cursor decodes `priorState` itself with the tolerant
     *  rules described on `openFingerprintCursor`. */
    priorFingerprints?: ReadonlyMap<string, string>;
    /** Compute the exclusion list per record instead of using one static list.
     *  Used by content-gated streams (PDF statements) whose exclusion depends on
     *  whether the record carries a positive content fingerprint: the gate moves
     *  the boundary between "blob/acquisition churn is a no-op" and "no positive
     *  signal, stay conservative" on a per-record basis. When provided, this
     *  takes precedence over `excludeFromFingerprint` for every record. */
    resolveExcludeFromFingerprint?: (record: Record<string, unknown>) => readonly string[];
}
export interface FingerprintCursor {
    /** Drop ids from the next map that were not observed this run.
     *  Idempotent. Must only be called on streams whose run is a full
     *  scan, because partial-scan streams have no business pruning ids
     *  they did not look at this run. If `shouldEmit` was called zero
     *  times this run, every prior id is dropped — that is the correct
     *  outcome for a requested full-scan stream that returned zero
     *  records. */
    dropUnseenIds: () => void;
    /** Prior cursor value for this id, if any. Use this when a connector
     *  has a derived-field-preservation policy (e.g. Codex pulls counts
     *  forward from the prior fingerprint when this run did not re-parse
     *  the source). The primitive does not encode policy — it just
     *  exposes the prior value. */
    priorFingerprint: (id: string) => string | undefined;
    /** Returns `true` iff the record's fingerprint differs from the prior
     *  cursor value for this id (or no prior exists). Always records the
     *  computed fingerprint into the next map and the id into the seen
     *  set — even when returning `false` — so STATE carry-forward is
     *  intact and the prune step has the right inputs.
     *
     *  Records whose `data.id` is null/undefined/empty cannot be
     *  fingerprinted; this method returns `true` for them and does NOT
     *  touch the next map or the seen set. The caller decides whether to
     *  emit. */
    shouldEmit: (data: RecordData) => boolean;
    /** Number of ids currently in the next map. Useful for callers that
     *  want to skip writing an empty `fingerprints` field. */
    size: () => number;
    /** Serializable cursor for STATE. The caller decides where to put
     *  this in the stream's cursor object (typically under a
     *  `fingerprints` key alongside other cursor fields). */
    toState: () => Record<string, string>;
}
/** Stable per-record fingerprint over the emitted record's fields. Keys
 *  are sorted recursively so the hash does not depend on incidental key
 *  order in the record builder. SHA-1 is fine for change detection: a
 *  collision between distinct shapes would silently skip one emit per
 *  record, and the run-clock-field risk dominates anyway.
 *
 *  Exposed because the four existing implementations all needed the
 *  same primitive under slightly different names; future migrations can
 *  import it directly without reaching for `openFingerprintCursor`. */
export declare function recordFingerprint(record: Record<string, unknown>, excludeKeys?: readonly string[]): string;
/** Open a cursor seeded from a prior STATE shape.
 *
 *  `priorState` is decoded tolerantly. The following shapes all produce
 *  an empty prior map without throwing:
 *    - `undefined` / `null`
 *    - any non-object value
 *    - arrays
 *    - an object missing a `fingerprints` field (legacy cursor shape)
 *    - a `fingerprints` field whose value is not an object
 *    - entries whose value is not a non-empty string
 *
 *  This matches the existing per-connector tolerance for legacy cursors
 *  and corrupt-on-disk state: a broken cursor never blocks a successful
 *  run, it just re-emits everything next time.
 *
 *  The cursor is seeded by copying the prior map into the next map so a
 *  record skipped this run still surfaces in the next STATE write. */
export declare function openFingerprintCursor(priorState: unknown, options?: FingerprintCursorOptions): FingerprintCursor;
//# sourceMappingURL=fingerprint-cursor.d.ts.map