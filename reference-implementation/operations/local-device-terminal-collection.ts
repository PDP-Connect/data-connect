// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { canonicalTerminalRunCommitEnvelope } from "@pdpp/collector-runtime/local-device-envelope";
import { canonicalTerminalRunCommitJson } from "@pdpp/reference-contract/common";
import {
  isLocalDeviceConnection,
  LOCAL_DEVICE_ACTOR_TYPE,
  NON_LOCAL_DEVICE_COVERAGE_REASON,
} from "../server/connector-instance-placement.ts";
import { fingerprintDeviceAttemptManifest } from "../server/device-ingest-attempt-context.ts";
import { readRuntimeCollectionFact } from "../server/runtime-collection-facts.ts";
import { type IssuedRunSequence, RunStartConflictError } from "../server/stores/collection-revision-store.ts";
import type {
  ResolvedTerminalRunCommit,
  TerminalRunCommitResult,
  TerminalRunReceiptLookup,
} from "../server/stores/terminal-run-commit-store.ts";
import {
  commitLegacyTerminalCollection,
  TerminalRunCommitConflictError,
} from "../server/stores/terminal-run-commit-store.ts";

const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;

interface TerminalRequest {
  readonly body?: unknown;
  readonly deviceExporter?: { readonly deviceId: string };
  readonly params: Readonly<Record<string, string>>;
}

interface TerminalResponse {
  json: (body: unknown) => unknown;
  status: (code: number) => TerminalResponse;
}

interface AuthorizedSource {
  readonly connectorInstance: { readonly connectorInstanceId: string; readonly sourceKind?: string | null };
  readonly sourceInstance: {
    readonly connectorId: string;
    readonly manifestGeneration?: number | null;
  };
}

interface TerminalContext {
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  handleError: (res: unknown, error: unknown) => void;
  pdppError: (res: unknown, status: number, code: string, message: string, param?: string) => void;
}

export interface TerminalRunCommitContext extends TerminalContext {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  commitTerminalRun: (input: ResolvedTerminalRunCommit) => Promise<TerminalRunCommitResult>;
  /**
   * Resolve a stored receipt for this exact binding before the request is
   * validated against the current manifest inventory. Optional: without it,
   * the store still answers a replay, but only after validation.
   */
  findTerminalRunReceipt?: (
    input: TerminalRunReceiptLookup
  ) => Promise<TerminalRunCommitResult | null> | TerminalRunCommitResult | null;
  getConnectorManifest?: (connectorId: string) => Promise<unknown> | unknown;
  getExpectedArtifactDigest?: (connectorId: string) => string | null;
  getRegisteredCollectionProfileRelease?: (
    connectorId: string,
    connectorInstanceId: string
  ) => Promise<RegisteredCollectionProfileRelease | null> | RegisteredCollectionProfileRelease | null;
}

export interface RegisteredCollectionProfileRelease {
  artifactDigest: string;
  manifest: unknown;
}

/**
 * Device-authenticated terminal commit boundary. Authorization and canonical
 * connection resolution complete before the durable store can inspect an
 * existing receipt, preventing cross-device/source receipt disclosure.
 */
export async function handleLocalDeviceTerminalRunCommit(input: {
  ctx: TerminalRunCommitContext;
  req: TerminalRequest;
  res: TerminalResponse;
  resolveAuthorizedSource: (deviceId: string, sourceInstanceId: string) => Promise<AuthorizedSource | null>;
}): Promise<void> {
  const { ctx, req, res } = input;
  try {
    const deviceId = decodeURIComponent(req.params.deviceId as string);
    const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId as string);
    if (deviceId !== req.deviceExporter?.deviceId) {
      ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
      return;
    }
    // This is the only receipt-lookup gateway. It resolves the complete
    // authenticated device/source/connection binding before store entry.
    const authorized = await input.resolveAuthorizedSource(deviceId, sourceInstanceId);
    if (!authorized) {
      return;
    }
    const body = asObject(req.body);
    const commitId = body && readRequiredString(body.commit_id);
    const reportedDeviceId = body && readRequiredString(body.device_id);
    const reportedSourceId = body && readRequiredString(body.source_instance_id);
    const reportedConnectorId = body && readRequiredString(body.connector_id);
    const reportedConnectorInstanceId = body && readRequiredString(body.connector_instance_id);
    const runId = body && readRequiredString(body.run_id);
    const collectionBoundary = body && readRequiredString(body.collection_boundary);
    const stateDelta = body && asObject(body.state_delta);
    const version = body?.version;
    const rawFacts = body && Array.isArray(body.terminal_facts) ? body.terminal_facts : null;
    const normalizedFacts = version === 1 && rawFacts ? normalizeTerminalFacts(rawFacts) : null;
    const canonicalConnectorId = ctx.canonicalConnectorKey(authorized.sourceInstance.connectorId);
    // Canonicalize BOTH sides before comparing, exactly as `sameConnectorType`
    // in routes/ref-device-exporters.ts already does for the record-batch leg.
    // Canonicalizing only the server's side and then demanding the device match
    // that exact spelling rejects a legacy alias the server itself recognises:
    // `canonicalConnectorKey("claude_code")` is `"claude-code"`, so a device
    // configured `PDPP_COLLECTOR_CONNECTOR=claude_code` failed this one guard
    // while its 10,000 record batches passed the symmetric one. Falling back to
    // the raw value keeps an unknown key failing closed.
    const reportedConnectorKey = reportedConnectorId
      ? (ctx.canonicalConnectorKey(reportedConnectorId) ?? reportedConnectorId)
      : null;
    if (
      (version !== 1 && version !== 2) ||
      !commitId ||
      reportedDeviceId !== deviceId ||
      reportedSourceId !== sourceInstanceId ||
      !reportedConnectorId ||
      reportedConnectorInstanceId !== authorized.connectorInstance.connectorInstanceId ||
      !runId ||
      !collectionBoundary ||
      !stateDelta ||
      !rawFacts ||
      (version === 1 && !normalizedFacts) ||
      !canonicalConnectorId ||
      reportedConnectorKey !== canonicalConnectorId
    ) {
      ctx.pdppError(res, 400, "invalid_request", "terminal run commit body or binding is invalid");
      return;
    }

    const canonicalEnvelope = {
      collection_boundary: collectionBoundary,
      commit_id: commitId,
      // The hash MUST be recomputed over the connector id the device actually
      // SENT, not the canonicalized one. The collector hashes the bytes it puts
      // on the wire and compares that digest against the `envelope_hash` this
      // route returns; substituting the canonical spelling here rehashes a
      // different envelope, so the digests never match. The guard above is
      // deliberately alias-tolerant, which means `claude_code` is accepted and
      // then silently rewritten to `claude-code` — every legacy alias that is
      // not identity (apple_photos, claude_code, google_messages,
      // google_takeout) dead-lettered its terminal commit forever. Storage
      // identity below stays canonical; only the hash input follows the wire.
      connector_id: reportedConnectorId,
      connector_instance_id: reportedConnectorInstanceId,
      device_id: deviceId,
      run_id: runId,
      source_instance_id: sourceInstanceId,
      state_delta: stateDelta,
      terminal_facts: body.terminal_facts,
      version,
    } as const;
    let canonicalJson: string;
    try {
      canonicalJson =
        version === 2
          ? JSON.stringify(
              canonicalTerminalRunCommitEnvelope(
                canonicalEnvelope as Parameters<typeof canonicalTerminalRunCommitEnvelope>[0]
              )
            )
          : canonicalTerminalRunCommitJson(canonicalEnvelope as Parameters<typeof canonicalTerminalRunCommitJson>[0]);
    } catch {
      ctx.pdppError(res, 400, "invalid_request", "terminal run commit body or binding is invalid");
      return;
    }
    const envelopeHash = createHash("sha256").update(canonicalJson).digest("hex");

    // An exact replay of a stored record gets its stored receipt, and a
    // different request for the same run binding is a conflict, before the
    // request is judged against the current manifest inventory. An inventory
    // change after the commit must not turn a replay into a 400. The binding
    // is already authorized above, and the store compares every binding field.
    const receipt = await ctx.findTerminalRunReceipt?.({
      commitId,
      connectorId: canonicalConnectorId,
      connectorInstanceId: authorized.connectorInstance.connectorInstanceId,
      deviceId,
      envelopeHash,
      runId,
      sourceInstanceId,
      version,
    });
    if (receipt) {
      res.status(200).json(receipt.response);
      return;
    }

    const registeredReleaseResolver = ctx.getRegisteredCollectionProfileRelease;
    const registeredRelease = registeredReleaseResolver
      ? await registeredReleaseResolver(canonicalConnectorId, authorized.connectorInstance.connectorInstanceId)
      : null;
    const registeredManifest = registeredReleaseResolver
      ? (registeredRelease?.manifest ?? (await ctx.getConnectorManifest?.(canonicalConnectorId)))
      : await ctx.getConnectorManifest?.(canonicalConnectorId);
    const expectedArtifactDigest = registeredReleaseResolver
      ? (registeredRelease?.artifactDigest ?? null)
      : (ctx.getExpectedArtifactDigest?.(canonicalConnectorId) ?? null);
    let expectedManifestFingerprint: string | null | undefined;
    if (registeredReleaseResolver) {
      expectedManifestFingerprint = registeredRelease
        ? fingerprintDeviceAttemptManifest(registeredRelease.manifest)
        : null;
    }
    const validatedFacts =
      version === 2
        ? normalizeTerminalRunRecordFacts(rawFacts, registeredManifest, collectionBoundary, {
            allowSubset: true,
            bindingGeneration: authorized.sourceInstance.manifestGeneration ?? null,
            expectedArtifactDigest,
            ...(expectedManifestFingerprint === undefined ? {} : { expectedManifestFingerprint }),
          })
        : normalizedFacts;
    if (!validatedFacts) {
      ctx.pdppError(res, 400, "invalid_request", "terminal coverage does not match the manifest inventory");
      return;
    }

    if (
      version === 2 &&
      validatedFacts.some(
        (fact) =>
          Object.hasOwn(stateDelta, String(fact.stream)) &&
          asObject(fact.runtime_accounting)?.checkpoint_eligible === false
      )
    ) {
      ctx.pdppError(res, 400, "invalid_request", "withheld checkpoint cannot advance stream state");
      return;
    }

    const coverage = terminalCoverageEligibilityForSource(validatedFacts, authorized.connectorInstance);

    const result = await ctx.commitTerminalRun({
      collectionBoundary,
      commitId,
      connectorId: canonicalConnectorId,
      connectorInstanceId: authorized.connectorInstance.connectorInstanceId,
      deviceId,
      envelopeHash,
      normalizedFacts: coverage.facts,
      ...(coverage.reason ? { coverageEligibilityReason: coverage.reason } : {}),
      runId,
      sourceInstanceId,
      stateDelta,
      version,
    });
    res.status(result.replayed ? 200 : 201).json(result.response);
  } catch (error) {
    if (error instanceof TerminalRunCommitConflictError) {
      ctx.pdppError(
        res,
        409,
        "terminal_run_commit_conflict",
        "Terminal run commit identity conflicts with an existing commit."
      );
      return;
    }
    ctx.handleError(res, error);
  }
}

export interface RunStartContext extends TerminalContext {
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  issueRunSequence: (input: {
    readonly connectorInstanceId: string;
    readonly deviceId: string;
    readonly runId: string;
    readonly sourceInstanceId: string;
  }) => Promise<{ readonly issued: IssuedRunSequence; readonly replayed: boolean }>;
}

/**
 * Register a run at its start and answer its run sequence. The sequence is
 * connection-scoped and issued under the connection row lock, so runs from
 * several devices are ordered by start. Only a run with a sequence can
 * produce an eligible positive coverage proof. An exact replay returns the
 * stored sequence; a run id registered to another device or source is a 409.
 */
export async function handleLocalDeviceRunStart(input: {
  ctx: RunStartContext;
  req: TerminalRequest;
  res: TerminalResponse;
  resolveAuthorizedSource: (deviceId: string, sourceInstanceId: string) => Promise<AuthorizedSource | null>;
}): Promise<void> {
  const { ctx, req, res } = input;
  try {
    const deviceId = decodeURIComponent(req.params.deviceId as string);
    const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId as string);
    if (deviceId !== req.deviceExporter?.deviceId) {
      ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
      return;
    }
    const authorized = await input.resolveAuthorizedSource(deviceId, sourceInstanceId);
    if (!authorized) {
      return;
    }
    const body = asObject(req.body);
    const runId = body && readRequiredString(body.run_id);
    const reportedConnectorId = body && readRequiredString(body.connector_id);
    const canonicalConnectorId = ctx.canonicalConnectorKey(authorized.sourceInstance.connectorId);
    const reportedConnectorKey = reportedConnectorId
      ? (ctx.canonicalConnectorKey(reportedConnectorId) ?? reportedConnectorId)
      : null;
    if (!(runId && canonicalConnectorId) || reportedConnectorKey !== canonicalConnectorId) {
      ctx.pdppError(res, 400, "invalid_request", "run start requires run_id and the source's connector_id");
      return;
    }
    const { issued, replayed } = await ctx.issueRunSequence({
      connectorInstanceId: authorized.connectorInstance.connectorInstanceId,
      deviceId,
      runId,
      sourceInstanceId,
    });
    res.status(replayed ? 200 : 201).json({
      connector_instance_id: issued.connectorInstanceId,
      object: "device_run_start",
      run_id: issued.runId,
      run_sequence: issued.runSequence,
      storage_epoch: issued.storageEpoch,
    });
  } catch (error) {
    if (error instanceof RunStartConflictError) {
      ctx.pdppError(res, 409, "run_start_conflict", "Run id is already registered to another device or source.");
      return;
    }
    ctx.handleError(res, error);
  }
}

/**
 * Turns an explicit local collector terminal report into the existing
 * terminal-event/fold contract. The report carries raw collector coverage
 * statuses through the canonical fact normalizer; policy stays in the
 * manifest-aware read-side coverage authority.
 */
export async function handleLocalDeviceTerminalCollection(input: {
  ctx: TerminalContext;
  req: TerminalRequest;
  res: TerminalResponse;
  resolveAuthorizedSource: (deviceId: string, sourceInstanceId: string) => Promise<AuthorizedSource | null>;
  sameConnectorType: (left: string, right: string) => boolean;
}): Promise<void> {
  const { ctx, req, res } = input;
  try {
    const deviceId = decodeURIComponent(req.params.deviceId as string);
    const sourceInstanceId = decodeURIComponent(req.params.sourceInstanceId as string);
    if (deviceId !== req.deviceExporter?.deviceId) {
      ctx.pdppError(res, 403, "permission_error", "Device credential is not valid for this device");
      return;
    }
    const authorized = await input.resolveAuthorizedSource(deviceId, sourceInstanceId);
    if (!authorized) {
      return;
    }
    const body = asObject(req.body);
    const connectorId = body && readRequiredString(body.connector_id);
    const runId = body && readRequiredString(body.run_id);
    const reportedSourceId = body && readRequiredString(body.source_instance_id);
    if (!(body && connectorId && runId) || reportedSourceId !== sourceInstanceId) {
      ctx.pdppError(
        res,
        400,
        "invalid_request",
        "terminal collection requires matching connector_id, run_id, and source_instance_id"
      );
      return;
    }
    if (!(input.sameConnectorType(authorized.sourceInstance.connectorId, connectorId) && Array.isArray(body.streams))) {
      ctx.pdppError(res, 400, "invalid_request", "terminal collection connector or streams is invalid");
      return;
    }
    const collectionScope = body && readRequiredString(body.collection_scope);
    const streams = normalizeTerminalFacts(body.streams);
    if (!streams) {
      ctx.pdppError(
        res,
        400,
        "invalid_request",
        "terminal collection requires at least one observed stream",
        "streams"
      );
      return;
    }
    // The split report is an observed collection event of its own. Its run
    // record takes the next collection revision in the same transaction, so a
    // report delayed past a newer proof retires that proof.
    const { connectorInstanceId } = authorized.connectorInstance;
    const coverage = terminalCoverageEligibilityForSource(streams, authorized.connectorInstance);
    const event = {
      actor_id: deviceId,
      actor_type: LOCAL_DEVICE_ACTOR_TYPE,
      data: {
        collection_facts: {
          // The boundary this evidence was measured against travels WITH it, so
          // a later scope change is detectable by comparison and stale proof can
          // never be read as describing the current region. `unscoped` is a real
          // value (a full pass); absent means a pre-scope collector reported it.
          ...(collectionScope ? { collection_scope: collectionScope } : {}),
          reference_only: true,
          schema_version: 1,
          ...(coverage.reason ? { coverage_eligibility_reason: coverage.reason } : {}),
          streams: coverage.facts,
        },
        connector_instance_id: authorized.connectorInstance.connectorInstanceId,
        // Durable compatibility telemetry for retiring the split terminal
        // protocol. Operators can count this marker in the existing spine;
        // new collectors never emit it because they use terminal-run-commits.
        legacy_terminal_protocol: {
          protocol: "split_state_and_terminal_collection_v1",
          retirement_not_before: "2026-11-12",
        },
      },
      event_id: `evt_local_device_terminal_${runId}`,
      event_type: "run.completed",
      object_id: runId,
      object_type: "run",
      run_id: runId,
      source_id: authorized.sourceInstance.connectorId,
      source_kind: "connector",
      status: "succeeded",
    };
    // An identical retry of a stored report is acknowledged without a new revision.
    const { replayed } = await commitLegacyTerminalCollection({ connectorInstanceId, event, runId });
    res.status(replayed ? 200 : 201).json({ ok: true });
  } catch (error) {
    if (error instanceof TerminalRunCommitConflictError) {
      ctx.pdppError(
        res,
        409,
        "terminal_collection_conflict",
        "A different terminal collection report is already stored for this run."
      );
      return;
    }
    ctx.handleError(res, error);
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function terminalCoverageEligibilityForSource(
  facts: readonly Record<string, unknown>[],
  instance: { readonly sourceKind?: string | null }
): { readonly facts: readonly Record<string, unknown>[]; readonly reason: string | null } {
  if (isLocalDeviceConnection(instance)) {
    return { facts, reason: null };
  }
  return {
    facts,
    reason: NON_LOCAL_DEVICE_COVERAGE_REASON,
  };
}

function readRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function normalizeTerminalFacts(rawFacts: readonly unknown[]): readonly Record<string, unknown>[] | null {
  const byStream = new Map<string, Record<string, unknown>>();
  for (const raw of rawFacts) {
    const entry = asObject(raw);
    const coverageStatuses = entry && readCoverageStatuses(entry.coverage_statuses);
    if (!(entry && coverageStatuses)) {
      return null;
    }
    // A successful terminal report proves its coverage checkpoint reached the
    // server, not that every source absence is a gap. Preserve the raw status
    // set and let the canonical manifest-aware policy classify accepted
    // absence. Only these existing collector statuses are true unresolved
    // evidence at this boundary.
    const pendingDetailGaps = coverageStatuses.filter(
      (status) => status === "missing" || status === "unaccounted"
    ).length;
    const fact = readRuntimeCollectionFact({
      checkpoint: "committed",
      collected: 0,
      considered: null,
      coverage_statuses: coverageStatuses,
      covered: null,
      pending_detail_gaps: pendingDetailGaps,
      skipped: null,
      stream: entry.stream,
    });
    if (!fact) {
      return null;
    }
    // `scoped` is the collector's statement that the declared boundary was
    // actually ENFORCEABLE on this stream. Dropping it would leave the server
    // unable to tell coverage-of-a-region from coverage-of-everything, so it is
    // preserved verbatim; absent means the run declared no boundary.
    const scoped = typeof entry.scoped === "boolean" ? { scoped: entry.scoped } : {};
    byStream.set(fact.stream, {
      ...scoped,
      checkpoint: fact.checkpoint,
      collected: fact.collected,
      considered: fact.considered,
      coverage_statuses: fact.coverage_statuses,
      covered: fact.covered,
      pending_detail_gaps: fact.pending_detail_gaps,
      skipped: fact.skipped,
      stream: fact.stream,
    });
  }
  return byStream.size > 0
    ? [...byStream.values()].sort((left, right) => String(left.stream).localeCompare(String(right.stream)))
    : null;
}

/**
 * A version 2 record with no facts makes no coverage claim: it is the terminal
 * run record every successful run commits. Without a registered manifest
 * there is no inventory to expand to unknown, so it stays empty. Any other
 * version 2 record is validated as a coverage claim.
 */
function normalizeTerminalRunRecordFacts(
  ...args: Parameters<typeof normalizeTerminalCoverageFacts>
): ReturnType<typeof normalizeTerminalCoverageFacts> {
  const [rawFacts, rawManifest] = args;
  if (rawFacts.length === 0 && !Array.isArray(asObject(rawManifest)?.streams)) {
    return [];
  }
  return normalizeTerminalCoverageFacts(...args);
}

/** Validate a v2 claim against the registered manifest, without source-specific rules. */
export function normalizeTerminalCoverageFacts(
  rawFacts: readonly unknown[],
  rawManifest: unknown,
  _collectionBoundary: string,
  options: {
    allowSubset?: boolean;
    bindingGeneration?: number | null;
    expectedArtifactDigest?: string | null;
    expectedManifestFingerprint?: string | null;
    validateBindingGeneration?: boolean;
    validateServerArtifactDigest?: boolean;
  } = {}
): readonly Record<string, unknown>[] | null {
  const manifest = asObject(rawManifest);
  const manifestStreams = manifest?.streams;
  if (!Array.isArray(manifestStreams) || manifestStreams.length === 0) {
    return null;
  }
  const manifestFingerprint =
    options.expectedManifestFingerprint ?? fingerprintDeviceAttemptManifest(rawManifest);
  const inventory = new Map<string, Set<string>>();
  const metadataOnlyStreams = new Set<string>();
  for (const rawStream of manifestStreams) {
    const stream = asObject(rawStream);
    const name = stream && readRequiredString(stream.name);
    const stores = stream?.coverage_stores;
    if (!name || inventory.has(name)) {
      return null;
    }
    if (stores === undefined && options.allowSubset) {
      inventory.set(name, new Set());
      continue;
    }
    if (
      !Array.isArray(stores) ||
      stores.length === 0 ||
      stores.some((store) => typeof store !== "string" || !store.trim()) ||
      new Set(stores).size !== stores.length ||
      inventory.has(name)
    ) {
      return null;
    }
    inventory.set(name, new Set(stores));
    if (stream?.coverage_policy === "inventory_only") {
      metadataOnlyStreams.add(name);
    }
  }
  if (
    (rawFacts.length === 0 && !options.allowSubset) ||
    rawFacts.length > inventory.size ||
    (!options.allowSubset && rawFacts.length !== inventory.size)
  ) {
    return null;
  }
  if (rawFacts.length === 0) {
    const expectedArtifactDigest = ARTIFACT_DIGEST.test(options.expectedArtifactDigest ?? "")
      ? options.expectedArtifactDigest
      : null;
    return [...inventory.entries()]
      .filter(([, stores]) => stores.size > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([stream, stores]) => ({
        ...(expectedArtifactDigest ? { artifact_digest: expectedArtifactDigest } : {}),
        ...(!expectedArtifactDigest ? { artifact_binding_reason: "artifact_digest_unknown" } : {}),
        checkpoint: "withheld",
        collected: 0,
        considered: null,
        covered: null,
        manifest_fingerprint: manifestFingerprint,
        server_artifact_digest: expectedArtifactDigest,
        ...(Number.isSafeInteger(options.bindingGeneration) ? { binding_generation: options.bindingGeneration } : {}),
        coverage_statuses: ["unknown"],
        pending_detail_gaps: 0,
        scoped: false,
        stores: [...stores].sort().map((store) => ({ status: "unknown", store })),
        stream,
      }));
  }
  const seen = new Set<string>();
  const facts: Record<string, unknown>[] = [];
  for (const raw of rawFacts) {
    const entry = asObject(raw);
    const stream = entry && readRequiredString(entry.stream);
    const expected = stream ? inventory.get(stream) : null;
    const rawStores = entry?.stores;
    if (
      !(stream && expected) ||
      expected.size === 0 ||
      seen.has(stream) ||
      typeof entry.scoped !== "boolean" ||
      !Array.isArray(rawStores) ||
      rawStores.length !== expected.size
    ) {
      return null;
    }
    seen.add(stream);
    const stores: {
      store: string;
      status: "collected" | "partial" | "unavailable" | "failed";
    }[] = [];
    const seenStores = new Set<string>();
    for (const rawStore of rawStores) {
      const store = asObject(rawStore);
      const name = store && readRequiredString(store.store);
      const status = store?.status;
      if (
        !(name && expected.has(name)) ||
        seenStores.has(name) ||
        (status !== "collected" && status !== "partial" && status !== "unavailable" && status !== "failed")
      ) {
        return null;
      }
      seenStores.add(name);
      stores.push({ status, store: name });
    }
    // Keep assertions separate from the verdict derived from host accounting.
    // Missing provenance remains unknown; a known contradiction is partial.
    stores.sort((left, right) => left.store.localeCompare(right.store));
    const accounting = readTerminalRuntimeAccounting(entry.runtime_accounting);
    const accountingKnown = accounting !== null;
    const generationMatches =
      !options.validateBindingGeneration ||
      (Number.isSafeInteger(options.bindingGeneration) && entry.binding_generation === options.bindingGeneration);
    let artifactBindingReason: "artifact_digest_mismatch" | "artifact_digest_unknown" | null = null;
    if (
      !ARTIFACT_DIGEST.test(options.expectedArtifactDigest ?? "") ||
      (options.validateServerArtifactDigest && !ARTIFACT_DIGEST.test(String(entry.server_artifact_digest ?? "")))
    ) {
      artifactBindingReason = "artifact_digest_unknown";
    } else if (
      entry.artifact_digest !== options.expectedArtifactDigest ||
      (options.validateServerArtifactDigest && entry.server_artifact_digest !== options.expectedArtifactDigest)
    ) {
      artifactBindingReason = "artifact_digest_mismatch";
    }
    const bound =
      generationMatches &&
      entry.manifest_fingerprint === manifestFingerprint &&
      (options.expectedManifestFingerprint === undefined ||
        (typeof options.expectedManifestFingerprint === "string" &&
          entry.manifest_fingerprint === options.expectedManifestFingerprint)) &&
      artifactBindingReason === null;
    const complete =
      accountingKnown &&
      accounting.durable_admission === true &&
      accounting.detail_complete === true &&
      accounting.stream_evidence_consistent === true &&
      accounting.checkpoint_eligible === true &&
      accounting.outstanding_debt === 0;
    const statuses = stores.map((store) => {
      if (store.status !== "collected") {
        return store.status;
      }
      if (!(bound && accountingKnown)) {
        return "unknown";
      }
      if (!complete) {
        return "partial";
      }
      return metadataOnlyStreams.has(stream) ? "inventory_only" : "collected";
    });
    const pendingDetailGaps = accountingKnown ? Number(accounting.outstanding_debt) : 0;
    facts.push({
      artifact_digest: entry.artifact_digest,
      ...(artifactBindingReason ? { artifact_binding_reason: artifactBindingReason } : {}),
      checkpoint: accountingKnown && accounting.checkpoint_eligible === true ? "committed" : "withheld",
      collected: 0,
      considered: null,
      covered: null,
      manifest_fingerprint: entry.manifest_fingerprint,
      server_artifact_digest: options.validateServerArtifactDigest
        ? entry.server_artifact_digest
        : (options.expectedArtifactDigest ?? null),
      ...(Number.isSafeInteger(options.bindingGeneration)
        ? {
            binding_generation: options.validateBindingGeneration
              ? entry.binding_generation
              : options.bindingGeneration,
          }
        : {}),
      ...(accountingKnown ? { runtime_accounting: accounting } : {}),
      coverage_statuses: statuses,
      pending_detail_gaps: pendingDetailGaps,
      scoped: entry.scoped,
      skipped: null,
      stores,
      stream,
    });
  }
  return seen.size === rawFacts.length
    ? facts.sort((left, right) => String(left.stream).localeCompare(String(right.stream)))
    : null;
}

function readCoverageStatuses(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.some((status) => typeof status !== "string" || !status)) {
    return null;
  }
  return [...new Set(value)].sort();
}

interface TerminalRuntimeAccounting {
  checkpoint_eligible: boolean;
  detail_complete: boolean;
  durable_admission: boolean;
  outstanding_debt: number;
  stream_evidence_consistent: boolean;
}

function readTerminalRuntimeAccounting(value: unknown): TerminalRuntimeAccounting | null {
  const accounting = asObject(value);
  if (
    !accounting ||
    typeof accounting.durable_admission !== "boolean" ||
    typeof accounting.detail_complete !== "boolean" ||
    typeof accounting.stream_evidence_consistent !== "boolean" ||
    typeof accounting.checkpoint_eligible !== "boolean" ||
    typeof accounting.outstanding_debt !== "number" ||
    !Number.isSafeInteger(accounting.outstanding_debt) ||
    accounting.outstanding_debt < 0
  ) {
    return null;
  }
  return {
    checkpoint_eligible: accounting.checkpoint_eligible,
    detail_complete: accounting.detail_complete,
    durable_admission: accounting.durable_admission,
    outstanding_debt: accounting.outstanding_debt,
    stream_evidence_consistent: accounting.stream_evidence_consistent,
  };
}
