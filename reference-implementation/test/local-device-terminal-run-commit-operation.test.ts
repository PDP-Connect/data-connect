// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalTerminalRunCommitJson } from "@pdpp/reference-contract/common";
import { handleLocalDeviceTerminalRunCommit } from "../operations/local-device-terminal-collection.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
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

// A connector no build ever listed must match its own identity, and only its own.
async function commitFromDeviceSendingWhatsappWeb(sourceConnectorId: string) {
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
            terminal_event_id: "evt-unlisted",
          },
        });
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
      body: validBody({ connector_id: "whatsapp-web" }),
      deviceExporter: { deviceId: "dev-1" },
      params: { deviceId: "dev-1", sourceInstanceId: "src-1" },
    },
    res: capture.response,
    resolveAuthorizedSource: () =>
      Promise.resolve({
        connectorInstance: { connectorInstanceId: "cin-1" },
        sourceInstance: { connectorId: sourceConnectorId },
      }),
  });
  return { committed: committed as ResolvedTerminalRunCommit | null, snapshot: capture.snapshot() };
}

test("a device sending an unlisted connector key commits against a source of the same key", async () => {
  const { committed, snapshot } = await commitFromDeviceSendingWhatsappWeb("whatsapp-web");
  assert.equal(snapshot.status, 201);
  assert.equal(committed?.connectorId, "whatsapp-web");
});

test("a device sending an unlisted connector key is rejected against a source of another unlisted key", async () => {
  const { committed, snapshot } = await commitFromDeviceSendingWhatsappWeb("other-unlisted");
  assert.deepEqual(snapshot, { body: { code: "invalid_request" }, status: 400 });
  assert.equal(committed, null, "mismatched connector ids must not reach the store");
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
 * A device configured with an old underscore connector id
 * (`PDPP_COLLECTOR_CONNECTOR=claude_code`) used to be rewritten to
 * `claude-code` on both sides. The server no longer rewrites ids: the old
 * spelling is an unknown connector, so it does not match the stored binding
 * and the ordinary binding check refuses it.
 *
 * Uses the REAL canonicalizer: it returns the old id unchanged. The commit
 * store must not be reached.
 */
test("a device sending an old connector id is refused by the binding check and commits nothing", async () => {
  const capture = responseCapture();
  let errored: { code: string; message: string | undefined; param: string | undefined; status: number } | null = null;
  let storeReached = false;
  await handleLocalDeviceTerminalRunCommit({
    ctx: {
      canonicalConnectorKey,
      commitTerminalRun: () => {
        storeReached = true;
        return Promise.reject(new Error("the commit store must not be reached for an old id"));
      },
      emitSpineEvent: () => Promise.resolve(),
      handleError: (_res, error) => {
        throw error;
      },
      pdppError: (_res, status, code, message, param) => {
        errored = { code, message, param, status };
      },
    },
    req: {
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
  const refusal = errored as { code: string; message: string | undefined; status: number } | null;
  assert.equal(refusal?.status, 400);
  assert.equal(refusal?.code, "invalid_request");
  assert.doesNotMatch(refusal?.message ?? "", /claude-code/, "the refusal does not name a replacement key");
  assert.equal(storeReached, false);
});

/**
 * Production defect, run 652780f6-3316-4e90-9c53-835cfb0af483: the server
 * rehashed an envelope whose connector id it had rewritten to the canonical
 * key, while the collector hashed the envelope it actually sent. The two
 * hashes never matched and the collector dead-lettered every terminal commit.
 *
 * A registry-URL spelling still canonicalizes to the bare key, so it can still
 * diverge from the stored binding. The 201 alone cannot catch this: the
 * request is accepted and only the returned hash is wrong. This case pins it.
 */
test("the envelope hash is computed over the connector id the device SENT, not the canonicalized one", async () => {
  const capture = responseCapture();
  let committed: ResolvedTerminalRunCommit | null = null;
  const sentBody = validBody({ connector_id: "https://registry.pdpp.dev/connectors/claude-code" });
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
            terminal_event_id: "evt-url-hash",
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
  assert.notEqual(clientHash, rewrittenHash, "the URL and bare-key spellings must actually hash differently");
  assert.equal(
    resolved.envelopeHash,
    clientHash,
    "the server must rehash the bytes the device sent; canonicalizing the hash input dead-letters every URL-spelled connector id"
  );

  // Storage identity stays canonical — only the hash input follows the wire.
  assert.equal(resolved.connectorId, "claude-code");
});

test("a bare-key connector id still hashes correctly — the URL case does not disturb the working path", async () => {
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
      // source's connector. Without this control, accepting every unknown value
      // could silently accept a foreign binding.
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
