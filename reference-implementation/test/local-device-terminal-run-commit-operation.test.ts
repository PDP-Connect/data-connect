// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalTerminalRunCommitEnvelope, hashCanonicalJson } from "@pdpp/collector-runtime/local-device-envelope";
import { canonicalTerminalRunCommitJson } from "@pdpp/reference-contract/common";
import {
  handleLocalDeviceTerminalRunCommit,
  normalizeTerminalCoverageFacts,
} from "../operations/local-device-terminal-collection.ts";
import { deriveStreamCoverageCondition } from "../server/connector-coverage-policy.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { fingerprintDeviceAttemptManifest } from "../server/device-ingest-attempt-context.ts";
import { readRuntimeCollectionFact } from "../server/runtime-collection-facts.ts";
import {
  commitTerminalRun as commitTerminalRunToStore,
  type ResolvedTerminalRunCommit,
  TerminalRunCommitConflictError,
} from "../server/stores/terminal-run-commit-store.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

function responseCapture() {
  let status = 0;
  let body: unknown;
  return {
    response: {
      json(value: unknown) {
        body = value;
        return value;
      },
      status(code: number) {
        status = code;
        return this;
      },
    },
    snapshot: () => ({ body, status }),
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    collection_boundary: "unscoped",
    commit_id: "commit-1",
    connector_id: "codex",
    connector_instance_id: "cin-1",
    device_id: "dev-1",
    run_id: "run-1",
    source_instance_id: "src-1",
    state_delta: { sessions: { cursor: "c1" } },
    terminal_facts: [{ coverage_statuses: ["collected", "collected"], stream: "sessions" }],
    version: 1,
    ...overrides,
  };
}

async function invokeBoundCoverageCommit(input: {
  claimDigest: string;
  claimManifest: Record<string, unknown>;
  claimStores: readonly string[];
  claimStream?: string;
  currentManifest: Record<string, unknown>;
  registeredRelease: { artifactDigest: string; manifest: Record<string, unknown> } | null;
}): Promise<{ committed: ResolvedTerminalRunCommit | null; status: number }> {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey: () => "codex",
      commitTerminalRun: (value) => {
        committed = value;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: value.commitId,
            envelope_hash: value.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: value.runId,
            terminal_event_id: "evt-bound-coverage",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      getConnectorManifest: () => input.currentManifest,
      getExpectedArtifactDigest: () => input.registeredRelease?.artifactDigest ?? null,
      getRegisteredCollectionProfileRelease: () => input.registeredRelease,
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status) => {
        capture.response.status(status);
      },
    },
    req: {
      body: validBody({
        state_delta: {},
        terminal_facts: [
          {
            artifact_digest: input.claimDigest,
            manifest_fingerprint: fingerprintDeviceAttemptManifest(input.claimManifest),
            runtime_accounting: {
              checkpoint_eligible: true,
              detail_complete: true,
              durable_admission: true,
              outstanding_debt: 0,
              stream_evidence_consistent: true,
            },
            scoped: true,
            stores: input.claimStores.map((store) => ({ status: "collected", store })),
            stream: input.claimStream ?? "messages",
          },
        ],
        version: 2,
      }),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "codex", manifestGeneration: 7 },
      }),
  });
  return { committed, status: capture.snapshot().status };
}

test("version 2 terminal coverage validates named stores against the manifest", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  const sentBody = validBody({
    state_delta: {},
    terminal_facts: [
      {
        scoped: true,
        stores: [
          { status: "collected", store: "messages" },
          { status: "partial", store: "history" },
        ],
        stream: "messages",
      },
    ],
    version: 2,
  });
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey: () => "codex",
      commitTerminalRun: (input) => {
        committed = input;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: input.commitId,
            envelope_hash: input.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: input.runId,
            terminal_event_id: "evt-v2",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      getConnectorManifest: () =>
        Promise.resolve({
          streams: [{ coverage_stores: ["messages", "history"], name: "messages" }],
        }),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status) => {
        capture.response.status(status);
      },
    },
    req: {
      body: sentBody,
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "codex", manifestGeneration: 7 },
      }),
  });
  assert.equal(capture.snapshot().status, 201);
  assert.ok(committed);
  assert.deepEqual((committed as ResolvedTerminalRunCommit).normalizedFacts[0]?.coverage_statuses, [
    "partial",
    "unknown",
  ]);
  assert.equal(
    (committed as ResolvedTerminalRunCommit).envelopeHash,
    hashCanonicalJson(
      canonicalTerminalRunCommitEnvelope(sentBody as Parameters<typeof canonicalTerminalRunCommitEnvelope>[0])
    )
  );
});

test("typed terminal coverage is green only for complete scoped store evidence", () => {
  const manifest = { streams: [{ coverage_stores: ["messages", "history"], name: "messages" }] };
  const fact = (statuses: readonly [string, string], scoped = true) => ({
    artifact_digest: `sha256:${"a".repeat(64)}`,
    manifest_fingerprint: fingerprintDeviceAttemptManifest(manifest),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    scoped,
    stores: [
      { status: statuses[0], store: "messages" },
      { status: statuses[1], store: "history" },
    ],
    stream: "messages",
  });
  const axis = (raw: unknown) => {
    const normalized = normalizeTerminalCoverageFacts([raw], manifest, "unscoped", {
      expectedArtifactDigest: `sha256:${"a".repeat(64)}`,
    });
    assert.ok(normalized);
    const parsed = readRuntimeCollectionFact(normalized[0]);
    assert.ok(parsed);
    return deriveStreamCoverageCondition(parsed, { coverage_strategy: "checkpoint_window" });
  };
  assert.equal(axis(fact(["collected", "collected"])), "complete");
  assert.notEqual(axis(fact(["collected", "partial"])), "complete");
  assert.notEqual(axis(fact(["failed", "collected"])), "complete");
  assert.notEqual(axis(fact(["collected", "collected"], false)), "complete");
  assert.equal(normalizeTerminalCoverageFacts([], manifest, "unscoped"), null);
  assert.equal(normalizeTerminalCoverageFacts([fact(["collected", "collected"])], { streams: [] }, "unscoped"), null);
  assert.equal(normalizeTerminalCoverageFacts([fact(["collected", "bogus"])], manifest, "unscoped"), null);
  assert.equal(
    normalizeTerminalCoverageFacts(
      [{ ...fact(["collected", "collected"]), stores: [{ status: "collected", store: "messages" }] }],
      manifest,
      "unscoped"
    ),
    null
  );
  assert.equal(normalizeTerminalCoverageFacts([fact(["collected", "collected"], false)], manifest, "bounded"), null);
});

test("a selected-stream terminal commit is accepted without proving omitted manifest streams", () => {
  const manifest = {
    streams: [
      { coverage_stores: ["messages"], name: "messages" },
      { coverage_stores: ["photos"], name: "photos" },
    ],
  };
  const selected = [{ scoped: true, stores: [{ status: "collected", store: "messages" }], stream: "messages" }];
  assert.equal(normalizeTerminalCoverageFacts(selected, manifest, "unscoped"), null);
  assert.equal(normalizeTerminalCoverageFacts(selected, manifest, "unscoped", { allowSubset: true })?.length, 1);
});

test("terminal run commit resolves authorization before receipt lookup and passes canonical binding", async () => {
  const capture = responseCapture();
  let authorized = false;
  let committed: ResolvedTerminalRunCommit | null = null;
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey: () => "codex",
      commitTerminalRun: (commitInput) => {
        assert.equal(authorized, true, "receipt store is unreachable before full source authorization");
        committed = commitInput;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: commitInput.commitId,
            envelope_hash: commitInput.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: commitInput.runId,
            terminal_event_id: "evt-1",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code) => {
        throw new Error(`unexpected ${status}:${code}`);
      },
    },
    req: {
      body: validBody(),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () => {
      authorized = true;
      return Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "https://registry.pdpp.dev/connectors/codex" },
      });
    },
  });
  assert.equal(capture.snapshot().status, 201);
  assert.ok(committed);
  const resolved = committed as ResolvedTerminalRunCommit;
  assert.equal(resolved.connectorId, "codex");
  assert.equal(resolved.connectorInstanceId, "cin-1");
  assert.deepEqual(resolved.normalizedFacts[0]?.coverage_statuses, ["collected"]);
  assert.equal(
    resolved.envelopeHash,
    createHash("sha256")
      .update(canonicalTerminalRunCommitJson({ ...validBody(), version: 1 }))
      .digest("hex")
  );
});

/**
 * Production defect, peregrine 2026-08-22: a terminal run commit dead-lettered
 * with `400 invalid_request` and blocked the Claude Code outbox for five days
 * (1 dead_letter behind 10,000 succeeded uploads).
 *
 * The device is configured `PDPP_COLLECTOR_CONNECTOR=claude_code` and sends
 * that spelling verbatim. The server canonicalized only ITS OWN side to
 * `claude-code` and then required the device to have sent that exact string.
 * The record-batch leg compares with `sameConnectorType`, which canonicalizes
 * BOTH sides — which is why 10,000 batches from the same device on the same
 * run succeeded while this one guard rejected the commit.
 *
 * The pre-existing cases here all use `codex`, which canonicalizes to itself,
 * and stub `canonicalConnectorKey: () => "codex"` — a constant that cannot
 * express a mismatch. This case uses the REAL canonicalizer so the alias is
 * actually exercised.
 */
test("a device sending the legacy connector alias still commits: both sides are canonicalized", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey,
      commitTerminalRun: (commitInput) => {
        committed = commitInput;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: commitInput.commitId,
            envelope_hash: commitInput.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: commitInput.runId,
            terminal_event_id: "evt-alias",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code, message) => {
        throw new Error(`unexpected ${status}:${code} ${message}`);
      },
    },
    req: {
      // The exact spelling the peregrine collector emits.
      body: validBody({ connector_id: "claude_code" }),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "claude-code" },
      }),
  });
  assert.equal(capture.snapshot().status, 201, "the legacy alias must not be rejected as an invalid binding");
  assert.ok(committed);
  assert.equal(
    (committed as ResolvedTerminalRunCommit).connectorId,
    "claude-code",
    "the committed binding is stored canonically regardless of which spelling the device sent"
  );
});

/**
 * Production defect, run 652780f6-3316-4e90-9c53-835cfb0af483: the alias fix
 * above made the GUARD alias-tolerant but left the HASH INPUT canonicalized.
 * The collector hashes the envelope it actually sent (`claude_code`); the
 * server rehashed a rewritten envelope (`claude-code`), so the two hashes
 * never matched and the collector dead-lettered every terminal commit
 * forever — 34 dead letters / 0 succeeded for claude_code, against
 * 182 succeeded / 0 dead letters for codex, whose key canonicalizes to
 * itself and therefore never diverged.
 *
 * The 201 assertion in the alias test above cannot catch this: the request is
 * accepted, and only the returned hash is wrong. This case pins the hash.
 */
test("the envelope hash is computed over the connector id the device SENT, not the canonicalized one", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  const sentBody = validBody({ connector_id: "claude_code" });
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey,
      commitTerminalRun: (commitInput) => {
        committed = commitInput;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: commitInput.commitId,
            envelope_hash: commitInput.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: commitInput.runId,
            terminal_event_id: "evt-alias-hash",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code, message) => {
        throw new Error(`unexpected ${status}:${code} ${message}`);
      },
    },
    req: {
      body: sentBody,
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "claude-code" },
      }),
  });
  assert.equal(capture.snapshot().status, 201);
  assert.ok(committed);
  const resolved = committed as ResolvedTerminalRunCommit;

  // What the collector itself computes: the bytes it put on the wire.
  const clientHash = createHash("sha256")
    .update(canonicalTerminalRunCommitJson({ ...sentBody, version: 1 }))
    .digest("hex");
  // What canonicalizing the hash input would produce instead. Pinned as a
  // NEGATIVE so a regression cannot pass by making both sides equal.
  const rewrittenHash = createHash("sha256")
    .update(canonicalTerminalRunCommitJson({ ...sentBody, connector_id: "claude-code", version: 1 }))
    .digest("hex");
  assert.notEqual(clientHash, rewrittenHash, "the alias and canonical spellings must actually hash differently");
  assert.equal(
    resolved.envelopeHash,
    clientHash,
    "the server must rehash the bytes the device sent; canonicalizing the hash input dead-letters every underscore alias"
  );

  // Storage identity stays canonical — only the hash input follows the wire.
  assert.equal(resolved.connectorId, "claude-code");
});

test("an identity-alias connector still hashes correctly — the alias fix does not disturb the working path", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  const sentBody = validBody({ connector_id: "codex" });
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey,
      commitTerminalRun: (commitInput) => {
        committed = commitInput;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: commitInput.commitId,
            envelope_hash: commitInput.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: commitInput.runId,
            terminal_event_id: "evt-codex-hash",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code, message) => {
        throw new Error(`unexpected ${status}:${code} ${message}`);
      },
    },
    req: {
      body: sentBody,
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "codex" },
      }),
  });
  assert.equal(capture.snapshot().status, 201);
  assert.ok(committed);
  const resolved = committed as ResolvedTerminalRunCommit;
  assert.equal(
    resolved.envelopeHash,
    createHash("sha256")
      .update(canonicalTerminalRunCommitJson({ ...sentBody, version: 1 }))
      .digest("hex")
  );
  assert.equal(resolved.connectorId, "codex");
});

test("an unrelated connector id is still rejected — canonicalizing both sides does not make the guard permissive", async () => {
  const capture = responseCapture();
  let status = 0;
  let errorCode = "";
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey,
      commitTerminalRun: () => {
        throw new Error("a mismatched connector must never reach the receipt store");
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, code, errCode) => {
        status = code;
        errorCode = errCode;
      },
    },
    req: {
      // `codex` is a real key that canonicalizes to itself — and is NOT this
      // source's connector. Without this control, mapping every unknown value
      // through the alias table could silently accept a foreign binding.
      body: validBody({ connector_id: "codex" }),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "claude-code" },
      }),
  });
  assert.equal(status, 400, "a connector that is not this source's must still fail closed");
  assert.equal(errorCode, "invalid_request");
});

test("wrong device cannot resolve a source or inspect a receipt", async () => {
  const capture = responseCapture();
  let resolved = false;
  let lookedUp = false;
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey: () => "codex",
      commitTerminalRun: () => {
        lookedUp = true;
        throw new Error("receipt disclosed");
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code) => {
        capture.response.status(status).json({ code });
      },
    },
    req: {
      body: validBody(),
      deviceExporter: { deviceId: "dev-other" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () => {
      resolved = true;
      return Promise.resolve(null);
    },
  });
  assert.equal(capture.snapshot().status, 403);
  assert.equal(resolved, false);
  assert.equal(lookedUp, false);
});

test("divergent receipt conflict returns a typed non-disclosing 409", async () => {
  const capture = responseCapture();
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey: () => "codex",
      commitTerminalRun: () => Promise.reject(new TerminalRunCommitConflictError()),
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code, message) => {
        capture.response.status(status).json({ code, message });
      },
    },
    req: {
      body: validBody(),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "codex" },
      }),
  });
  assert.equal(capture.snapshot().status, 409);
  assert.deepEqual(capture.snapshot().body, {
    code: "terminal_run_commit_conflict",
    message: "Terminal run commit identity conflicts with an existing commit.",
  });
  assert.equal(JSON.stringify(capture.snapshot().body).includes("envelope_hash"), false);
});

test("SQLite route operation composes authorization with 201, exact response-loss replay, and non-disclosing 409", async () => {
  initDb(makeTemporaryDbPath("pdpp-terminal-operation-sqlite-"));
  try {
    const now = "2026-08-12T12:00:00.000Z";
    getDb().prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)").run("codex", now);
    getDb()
      .prepare(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at
         ) VALUES ('cin-1', 'owner_local', 'codex', 'Codex', 'active',
           'local_device', 'device:source', '{}', ?, ?)`
      )
      .run(now, now);

    const invoke = async (body: Record<string, unknown>, authenticatedDeviceId = "dev-1") => {
      const capture = responseCapture();
      let resolved = false;
      await handleLocalDeviceTerminalRunCommit({
        ctx: {
          canonicalConnectorKey: () => "codex",
          commitTerminalRun: commitTerminalRunToStore,
          emitSpineEvent: () => Promise.resolve(),
          handleError: (_res, error) => {
            throw error;
          },
          pdppError: (_res, status, code, message) => capture.response.status(status).json({ code, message }),
        },
        req: {
          body,
          deviceExporter: { deviceId: authenticatedDeviceId },
          params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
        },
        res: capture.response,
        resolveAuthorizedSource: () => {
          resolved = true;
          return Promise.resolve({
            connectorInstance: { connectorInstanceId: "cin-1" },
            sourceInstance: { connectorId: "https://registry.pdpp.dev/connectors/codex" },
          });
        },
      });
      return { ...capture.snapshot(), resolved };
    };

    const unauthorized = await invoke(validBody(), "dev-other");
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.resolved, false);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM spine_events").get() as { n: number }).n, 0);

    const first = await invoke(validBody());
    const replay = await invoke(validBody());
    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);

    const conflict = await invoke(validBody({ state_delta: { sessions: { cursor: "different" } } }));
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, {
      code: "terminal_run_commit_conflict",
      message: "Terminal run commit identity conflicts with an existing commit.",
    });
    assert.equal(JSON.stringify(conflict.body).includes("envelope_hash"), false);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM spine_events").get() as { n: number }).n, 1);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM run_history").get() as { n: number }).n, 1);
  } finally {
    closeDb();
  }
});

test("selected instrumented stream is accepted beside an uninstrumented stream", () => {
  const manifest = { streams: [{ coverage_stores: ["messages"], name: "messages" }, { name: "photos" }] };
  const selected = [{ scoped: true, stores: [{ status: "collected", store: "messages" }], stream: "messages" }];
  assert.equal(normalizeTerminalCoverageFacts(selected, manifest, "unscoped", { allowSubset: true })?.length, 1);
  assert.equal(normalizeTerminalCoverageFacts(selected, manifest, "unscoped"), null);
});

test("connector collected assertions cannot override runtime accounting or absent admission", () => {
  const manifest = { streams: [{ coverage_stores: ["messages"], name: "messages" }], version: "1" };
  const raw = {
    artifact_digest: `sha256:${"a".repeat(64)}`,
    manifest_fingerprint: fingerprintDeviceAttemptManifest(manifest),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    scoped: true,
    stores: [{ status: "collected", store: "messages" }],
    stream: "messages",
  };
  for (const override of [
    { durable_admission: false },
    { detail_complete: false },
    { stream_evidence_consistent: false },
    { outstanding_debt: 1 },
    { checkpoint_eligible: false },
  ]) {
    const normalized = normalizeTerminalCoverageFacts(
      [{ ...raw, runtime_accounting: { ...raw.runtime_accounting, ...override } }],
      manifest,
      "unscoped"
    );
    assert.ok(normalized);
    assert.notEqual((normalized[0]?.coverage_statuses as string[] | undefined)?.[0], "collected");
    assert.deepEqual(normalized[0]?.stores, raw.stores, "retain the connector assertion");
  }
  assert.notEqual(
    (
      normalizeTerminalCoverageFacts([{ ...raw, runtime_accounting: undefined }], manifest, "unscoped")?.[0]
        ?.coverage_statuses as string[] | undefined
    )?.[0],
    "collected"
  );
  assert.notEqual(
    (
      normalizeTerminalCoverageFacts([raw], { ...manifest, version: "2" }, "unscoped")?.[0]?.coverage_statuses as
        | string[]
        | undefined
    )?.[0],
    "collected"
  );
});

test("terminal collection requires the server's active artifact digest even when the manifest is unchanged", () => {
  const manifest = { streams: [{ coverage_stores: ["messages"], name: "messages" }] };
  const knownDigest = `sha256:${"a".repeat(64)}`;
  const raw = {
    artifact_digest: knownDigest,
    manifest_fingerprint: fingerprintDeviceAttemptManifest(manifest),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    scoped: true,
    stores: [{ status: "collected", store: "messages" }],
    stream: "messages",
  };
  const normalize = (fact: typeof raw, expectedArtifactDigest: string | null) => {
    const normalized = normalizeTerminalCoverageFacts([fact], manifest, "unscoped", { expectedArtifactDigest });
    assert.ok(normalized);
    return normalized[0];
  };
  assert.deepEqual(normalize(raw, knownDigest)?.coverage_statuses, ["collected"]);
  const mismatched = normalize({ ...raw, artifact_digest: `sha256:${"b".repeat(64)}` }, knownDigest);
  assert.deepEqual(mismatched?.coverage_statuses, ["unknown"]);
  assert.equal(mismatched?.artifact_binding_reason, "artifact_digest_mismatch");
  const unpinned = normalize(raw, null);
  assert.deepEqual(unpinned?.coverage_statuses, ["unknown"]);
  assert.equal(unpinned?.artifact_binding_reason, "artifact_digest_unknown");
  assert.equal(unpinned?.server_artifact_digest, null);
  const afterLaterPin = normalizeTerminalCoverageFacts([unpinned], manifest, "unscoped", {
    expectedArtifactDigest: knownDigest,
    validateServerArtifactDigest: true,
  });
  assert.deepEqual(afterLaterPin?.[0]?.coverage_statuses, ["unknown"], "a later pin cannot green an unbound run");
  const matchingAtCommit = normalize(raw, knownDigest);
  const matchingAtRead = normalizeTerminalCoverageFacts([matchingAtCommit], manifest, "unscoped", {
    expectedArtifactDigest: knownDigest,
    validateServerArtifactDigest: true,
  });
  assert.deepEqual(matchingAtRead?.[0]?.coverage_statuses, ["collected"]);
  const afterReplacement = normalizeTerminalCoverageFacts([matchingAtCommit], manifest, "unscoped", {
    expectedArtifactDigest: `sha256:${"b".repeat(64)}`,
    validateServerArtifactDigest: true,
  });
  assert.deepEqual(afterReplacement?.[0]?.coverage_statuses, ["unknown"]);
});

test("terminal commit records the server pin at admission and refuses an unbound positive verdict", async () => {
  const manifest = { streams: [{ coverage_stores: ["messages"], name: "messages" }] };
  const knownDigest = `sha256:${"a".repeat(64)}`;
  await Promise.all(
    [knownDigest, `sha256:${"b".repeat(64)}`, null].map(async (expectedDigest) => {
      const capture = responseCapture();
      let committed: ResolvedTerminalRunCommit | null = null;
      await handleLocalDeviceTerminalRunCommit({
        ctx: {
          canonicalConnectorKey: () => "codex",
          commitTerminalRun: (input) => {
            committed = input;
            return Promise.resolve({
              replayed: false,
              response: {
                commit_id: input.commitId,
                envelope_hash: input.envelopeHash,
                object: "device_terminal_run_commit",
                run_id: input.runId,
                terminal_event_id: "evt-v2",
              },
            });
          },
          emitSpineEvent: () => Promise.resolve(),
          getConnectorManifest: () => manifest,
          getExpectedArtifactDigest: () => expectedDigest,
          handleError: (_res, error) => {
            throw error;
          },
          pdppError: (_res, status) => {
            capture.response.status(status);
          },
        },
        req: {
          body: validBody({
            state_delta: {},
            terminal_facts: [
              {
                artifact_digest: knownDigest,
                manifest_fingerprint: fingerprintDeviceAttemptManifest(manifest),
                runtime_accounting: {
                  checkpoint_eligible: true,
                  detail_complete: true,
                  durable_admission: true,
                  outstanding_debt: 0,
                  stream_evidence_consistent: true,
                },
                scoped: true,
                stores: [{ status: "collected", store: "messages" }],
                stream: "messages",
              },
            ],
            version: 2,
          }),
          deviceExporter: { deviceId: "dev-1" },
          params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
        },
        res: capture.response,
        resolveAuthorizedSource: () =>
          Promise.resolve({
            connectorInstance: { connectorInstanceId: "cin-1" },
            sourceInstance: { connectorId: "codex", manifestGeneration: 7 },
          }),
      });
      assert.equal(capture.snapshot().status, 201);
      assert.ok(committed);
      const { normalizedFacts } = committed as ResolvedTerminalRunCommit;
      assert.equal(normalizedFacts[0]?.server_artifact_digest, expectedDigest);
      assert.deepEqual(normalizedFacts[0]?.coverage_statuses, [
        expectedDigest === knownDigest ? "collected" : "unknown",
      ]);
    })
  );
});

test("terminal coverage requires the release registered for the authorized connector instance", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  const registeredManifest = {
    streams: [{ coverage_stores: ["messages"], name: "messages" }],
    version: "1.0.0",
  };
  const currentManifest = {
    streams: [{ coverage_stores: ["messages"], name: "messages" }],
    version: "2.0.0",
  };
  const registeredDigest = `sha256:${"a".repeat(64)}`;
  const currentDigest = `sha256:${"b".repeat(64)}`;
  const body = validBody({
    state_delta: {},
    terminal_facts: [
      {
        artifact_digest: currentDigest,
        manifest_fingerprint: fingerprintDeviceAttemptManifest(currentManifest),
        runtime_accounting: {
          checkpoint_eligible: true,
          detail_complete: true,
          durable_admission: true,
          outstanding_debt: 0,
          stream_evidence_consistent: true,
        },
        scoped: true,
        stores: [{ status: "collected", store: "messages" }],
        stream: "messages",
      },
    ],
    version: 2,
  });
  const ctx = {
    canonicalConnectorKey: () => "codex",
    commitTerminalRun: (input: ResolvedTerminalRunCommit) => {
      committed = input;
      return Promise.resolve({
        replayed: false,
        response: {
          commit_id: input.commitId,
          envelope_hash: input.envelopeHash,
          object: "device_terminal_run_commit" as const,
          run_id: input.runId,
          terminal_event_id: "evt-release-binding",
        },
      });
    },
    emitSpineEvent: () => Promise.resolve(),
    getConnectorManifest: () => currentManifest,
    getExpectedArtifactDigest: () => currentDigest,
    getRegisteredCollectionProfileRelease: (connectorId: string, connectorInstanceId: string) => {
      assert.equal(connectorId, "codex");
      assert.equal(connectorInstanceId, "cin-1");
      return { artifactDigest: registeredDigest, manifest: registeredManifest };
    },
    handleError: (_res: unknown, error: unknown) => {
      throw error;
    },
    pdppError: (_res: unknown, status: number) => {
      capture.response.status(status);
    },
  };
  await handleLocalDeviceTerminalRunCommit({
    ctx,
    req: {
      body,
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "codex", manifestGeneration: 7 },
      }),
  });

  assert.equal(capture.snapshot().status, 201);
  assert.ok(committed);
  const fact = (committed as ResolvedTerminalRunCommit).normalizedFacts[0];
  assert.deepEqual(fact?.coverage_statuses, ["unknown"], "current release B cannot authorize an A-instance claim");
  assert.equal(fact?.server_artifact_digest, registeredDigest);
});

test("a run bound to its registered release remains valid after the connector catalog advances", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  const registeredManifest = {
    streams: [{ coverage_stores: ["messages"], name: "messages" }],
    version: "1.0.0",
  };
  const currentManifest = {
    streams: [{ coverage_stores: ["messages"], name: "messages" }],
    version: "2.0.0",
  };
  const registeredDigest = `sha256:${"a".repeat(64)}`;
  const currentDigest = `sha256:${"b".repeat(64)}`;
  const body = validBody({
    state_delta: {},
    terminal_facts: [
      {
        artifact_digest: registeredDigest,
        manifest_fingerprint: fingerprintDeviceAttemptManifest(registeredManifest),
        runtime_accounting: {
          checkpoint_eligible: true,
          detail_complete: true,
          durable_admission: true,
          outstanding_debt: 0,
          stream_evidence_consistent: true,
        },
        scoped: true,
        stores: [{ status: "collected", store: "messages" }],
        stream: "messages",
      },
    ],
    version: 2,
  });
  const ctx = {
    canonicalConnectorKey: () => "codex",
    commitTerminalRun: (input: ResolvedTerminalRunCommit) => {
      committed = input;
      return Promise.resolve({
        replayed: false,
        response: {
          commit_id: input.commitId,
          envelope_hash: input.envelopeHash,
          object: "device_terminal_run_commit" as const,
          run_id: input.runId,
          terminal_event_id: "evt-release-race",
        },
      });
    },
    emitSpineEvent: () => Promise.resolve(),
    getConnectorManifest: () => currentManifest,
    getExpectedArtifactDigest: () => currentDigest,
    getRegisteredCollectionProfileRelease: () => ({ artifactDigest: registeredDigest, manifest: registeredManifest }),
    handleError: (_res: unknown, error: unknown) => {
      throw error;
    },
    pdppError: (_res: unknown, status: number) => {
      capture.response.status(status);
    },
  };
  await handleLocalDeviceTerminalRunCommit({
    ctx,
    req: {
      body,
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "codex", manifestGeneration: 7 },
      }),
  });

  assert.equal(capture.snapshot().status, 201);
  assert.ok(committed);
  const fact = (committed as ResolvedTerminalRunCommit).normalizedFacts[0];
  assert.deepEqual(fact?.coverage_statuses, ["collected"]);
  assert.equal(fact?.server_artifact_digest, registeredDigest);
});

test("a v2 claim cannot pair a registered digest with another manifest fingerprint", () => {
  const registeredManifest = {
    streams: [{ coverage_stores: ["messages"], name: "messages" }],
    version: "1.0.0",
  };
  const currentManifest = {
    streams: [{ coverage_stores: ["messages"], name: "messages" }],
    version: "2.0.0",
  };
  const registeredDigest = `sha256:${"a".repeat(64)}`;
  const fact = {
    artifact_digest: registeredDigest,
    manifest_fingerprint: fingerprintDeviceAttemptManifest(currentManifest),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    scoped: true,
    stores: [{ status: "collected", store: "messages" }],
    stream: "messages",
  };
  const options = {
    expectedArtifactDigest: registeredDigest,
    expectedManifestFingerprint: fingerprintDeviceAttemptManifest(registeredManifest),
  };
  const normalized = normalizeTerminalCoverageFacts([fact], currentManifest, "unscoped", options);
  assert.ok(normalized);
  assert.deepEqual(normalized[0]?.coverage_statuses, ["unknown"]);
});

test("the terminal endpoint makes a registered digest mismatch unknown with the registered inventory", async () => {
  const registeredManifest = { streams: [{ coverage_stores: ["messages"], name: "messages" }] };
  const registeredDigest = `sha256:${"a".repeat(64)}`;
  const result = await invokeBoundCoverageCommit({
    claimDigest: `sha256:${"b".repeat(64)}`,
    claimManifest: registeredManifest,
    claimStores: ["messages"],
    currentManifest: registeredManifest,
    registeredRelease: { artifactDigest: registeredDigest, manifest: registeredManifest },
  });

  assert.equal(result.status, 201);
  assert.ok(result.committed);
  assert.deepEqual(result.committed.normalizedFacts[0]?.coverage_statuses, ["unknown"]);
  assert.equal(result.committed.normalizedFacts[0]?.artifact_binding_reason, "artifact_digest_mismatch");
});

test("the terminal endpoint keeps an unregistered digest unknown", async () => {
  const manifest = { streams: [{ coverage_stores: ["messages"], name: "messages" }] };
  const result = await invokeBoundCoverageCommit({
    claimDigest: `sha256:${"c".repeat(64)}`,
    claimManifest: manifest,
    claimStores: ["messages"],
    currentManifest: manifest,
    registeredRelease: null,
  });

  assert.equal(result.status, 201);
  assert.ok(result.committed);
  assert.deepEqual(result.committed.normalizedFacts[0]?.coverage_statuses, ["unknown"]);
  assert.equal(result.committed.normalizedFacts[0]?.artifact_binding_reason, "artifact_digest_unknown");
});

test("the terminal endpoint rejects a store outside the registered inventory", async () => {
  const registeredManifest = { streams: [{ coverage_stores: ["messages", "history"], name: "messages" }] };
  const digest = `sha256:${"a".repeat(64)}`;
  const result = await invokeBoundCoverageCommit({
    claimDigest: digest,
    claimManifest: registeredManifest,
    claimStores: ["history", "messages", "unexpected"],
    currentManifest: registeredManifest,
    registeredRelease: { artifactDigest: digest, manifest: registeredManifest },
  });

  assert.equal(result.status, 400);
  assert.equal(result.committed, null);
});

// Collection Profile Section 5.8.2: a stream with no declared inventory cannot
// prove coverage. The endpoint rejects a claim that names one, with or without
// stores, and commits nothing.
test("the terminal endpoint rejects a claim for a stream with no declared inventory", async () => {
  const registeredManifest = { streams: [{ coverage_stores: ["messages"], name: "messages" }, { name: "photos" }] };
  const digest = `sha256:${"a".repeat(64)}`;
  for (const claimStores of [[], ["photos"]]) {
    const result = await invokeBoundCoverageCommit({
      claimDigest: digest,
      claimManifest: registeredManifest,
      claimStores,
      claimStream: "photos",
      currentManifest: registeredManifest,
      registeredRelease: { artifactDigest: digest, manifest: registeredManifest },
    });
    assert.equal(result.status, 400, JSON.stringify(claimStores));
    assert.equal(result.committed, null);
  }
});

test("an instance registered to release A cannot claim a larger release B inventory", async () => {
  const registeredManifest = { streams: [{ coverage_stores: ["messages"], name: "messages" }] };
  const currentManifest = {
    streams: [{ coverage_stores: ["messages", "history"], name: "messages" }],
  };
  const registeredDigest = `sha256:${"a".repeat(64)}`;
  const currentDigest = `sha256:${"b".repeat(64)}`;
  const result = await invokeBoundCoverageCommit({
    claimDigest: currentDigest,
    claimManifest: currentManifest,
    claimStores: ["history", "messages"],
    currentManifest,
    registeredRelease: { artifactDigest: registeredDigest, manifest: registeredManifest },
  });

  assert.equal(result.status, 400);
  assert.equal(result.committed, null);
});

test("unregistered well-formed artifact digests remain unknown", () => {
  const manifest = { streams: [{ coverage_stores: ["messages"], name: "messages" }] };
  const fact = {
    artifact_digest: `sha256:${"a".repeat(64)}`,
    manifest_fingerprint: fingerprintDeviceAttemptManifest(manifest),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    scoped: true,
    stores: [{ status: "collected", store: "messages" }],
    stream: "messages",
  };
  const normalized = normalizeTerminalCoverageFacts([fact], manifest, "unscoped", { expectedArtifactDigest: null });
  assert.ok(normalized);
  assert.deepEqual(normalized[0]?.coverage_statuses, ["unknown"]);
  assert.equal(normalized[0]?.artifact_binding_reason, "artifact_digest_unknown");
});

test("v2 claims with an extra store outside the registered inventory are rejected", () => {
  const manifest = { streams: [{ coverage_stores: ["messages", "history"], name: "messages" }] };
  const fact = {
    artifact_digest: `sha256:${"a".repeat(64)}`,
    manifest_fingerprint: fingerprintDeviceAttemptManifest(manifest),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    scoped: true,
    stores: [
      { status: "collected", store: "history" },
      { status: "collected", store: "messages" },
      { status: "collected", store: "unexpected" },
    ],
    stream: "messages",
  };
  assert.equal(normalizeTerminalCoverageFacts([fact], manifest, "unscoped"), null);
});

test("v2 normalization rejects duplicate streams and duplicate stores", () => {
  const manifest = { streams: [{ coverage_stores: ["messages"], name: "messages" }] };
  const fact = {
    artifact_digest: `sha256:${"a".repeat(64)}`,
    manifest_fingerprint: fingerprintDeviceAttemptManifest(manifest),
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    scoped: true,
    stores: [{ status: "collected", store: "messages" }],
    stream: "messages",
  };
  assert.equal(normalizeTerminalCoverageFacts([fact, fact], manifest, "unscoped"), null);
  assert.equal(
    normalizeTerminalCoverageFacts(
      [{ ...fact, stores: [fact.stores[0], fact.stores[0]] }],
      manifest,
      "unscoped"
    ),
    null
  );
});

test("a successful empty v2 terminal commit replaces every store with unknown evidence", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  const manifest = {
    streams: [
      { coverage_stores: ["messages", "history"], name: "messages" },
      { coverage_stores: ["sessions"], name: "sessions" },
    ],
  };
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey: () => "codex",
      commitTerminalRun: (input) => {
        committed = input;
        return Promise.resolve({
          replayed: false,
          response: {
            commit_id: input.commitId,
            envelope_hash: input.envelopeHash,
            object: "device_terminal_run_commit",
            run_id: input.runId,
            terminal_event_id: "evt-unknown-replacement",
          },
        });
      },
      emitSpineEvent: () => Promise.resolve(),
      getConnectorManifest: () => manifest,
      getExpectedArtifactDigest: () => `sha256:${"a".repeat(64)}`,
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status) => {
        capture.response.status(status);
      },
    },
    req: {
      body: validBody({ state_delta: {}, terminal_facts: [], version: 2 }),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: "codex", manifestGeneration: 7 },
      }),
  });

  assert.equal(capture.snapshot().status, 201);
  assert.ok(committed);
  const facts = (committed as ResolvedTerminalRunCommit).normalizedFacts;
  assert.deepEqual(
    facts.map((fact) => [fact.stream, fact.stores]),
    [
      ["messages", [{ store: "history", status: "unknown" }, { store: "messages", status: "unknown" }]],
      ["sessions", [{ store: "sessions", status: "unknown" }]],
    ]
  );
});

test("proven empty content is complete while metadata inventory stays inventory only", () => {
  for (const coveragePolicy of ["collect", "inventory_only"]) {
    const manifest = {
      streams: [{ coverage_policy: coveragePolicy, coverage_stores: ["messages"], name: "messages" }],
    };
    const raw = {
      artifact_digest: `sha256:${"a".repeat(64)}`,
      manifest_fingerprint: fingerprintDeviceAttemptManifest(manifest),
      runtime_accounting: {
        checkpoint_eligible: true,
        detail_complete: true,
        durable_admission: true,
        outstanding_debt: 0,
        stream_evidence_consistent: true,
      },
      scoped: true,
      stores: [{ status: "collected", store: "messages" }],
      stream: "messages",
    };
    const normalized = normalizeTerminalCoverageFacts([raw], manifest, "unscoped", {
      expectedArtifactDigest: `sha256:${"a".repeat(64)}`,
    });
    assert.ok(normalized);
    assert.equal(normalized[0]?.collected, 0, "no records admitted for proven empty enumeration");
    assert.deepEqual(normalized[0]?.coverage_statuses, [coveragePolicy === "collect" ? "collected" : "inventory_only"]);
  }
});

for (const eligible of [false, true]) {
  test(`checkpoint eligibility ${eligible} governs state advancement with accounted debt`, async () => {
    const capture = responseCapture();
    let committed = false;
    await handleLocalDeviceTerminalRunCommit({
      ctx: {
        canonicalConnectorKey: () => "codex",
        commitTerminalRun: (input) => {
          committed = true;
          return Promise.resolve({
            replayed: false,
            response: {
              commit_id: input.commitId,
              envelope_hash: input.envelopeHash,
              object: "device_terminal_run_commit",
              run_id: input.runId,
              terminal_event_id: "evt",
            },
          });
        },
        emitSpineEvent: () => Promise.resolve(),
        getConnectorManifest: () => ({ streams: [{ coverage_stores: ["messages"], name: "messages" }] }),
        handleError: (_res, error) => {
          throw error;
        },
        pdppError: (_res, status) => {
          capture.response.status(status);
        },
      },
      req: {
        body: validBody({
          state_delta: { messages: { cursor: "new" } },
          terminal_facts: [
            {
              runtime_accounting: {
                checkpoint_eligible: eligible,
                detail_complete: false,
                durable_admission: true,
                outstanding_debt: 1,
                stream_evidence_consistent: true,
              },
              scoped: true,
              stores: [{ status: "partial", store: "messages" }],
              stream: "messages",
            },
          ],
          version: 2,
        }),
        deviceExporter: { deviceId: "dev-1" },
        params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
      },
      res: capture.response,
      resolveAuthorizedSource: () =>
        Promise.resolve({
          connectorInstance: { connectorInstanceId: "cin-1" },
          sourceInstance: { connectorId: "codex" },
        }),
    });
    assert.equal(capture.snapshot().status, eligible ? 201 : 400);
    assert.equal(committed, eligible);
  });
}

test("v2 envelope identity binds accounting and executed release provenance", () => {
  const fact = {
    artifact_digest: `sha256:${"a".repeat(64)}`,
    manifest_fingerprint: "manifest-a",
    runtime_accounting: {
      checkpoint_eligible: true,
      detail_complete: true,
      durable_admission: true,
      outstanding_debt: 0,
      stream_evidence_consistent: true,
    },
    scoped: true,
    stores: [{ status: "collected", store: "messages" }],
    stream: "messages",
  };
  const hash = (value: Record<string, unknown>) =>
    hashCanonicalJson(
      canonicalTerminalRunCommitEnvelope(
        validBody({ terminal_facts: [value], version: 2 }) as Parameters<typeof canonicalTerminalRunCommitEnvelope>[0]
      )
    );
  const original = hash(fact);
  assert.notEqual(hash({ ...fact, manifest_fingerprint: "manifest-b" }), original);
  assert.notEqual(hash({ ...fact, artifact_digest: `sha256:${"b".repeat(64)}` }), original);
  assert.notEqual(
    hash({ ...fact, runtime_accounting: { ...fact.runtime_accounting, durable_admission: false } }),
    original
  );
});
