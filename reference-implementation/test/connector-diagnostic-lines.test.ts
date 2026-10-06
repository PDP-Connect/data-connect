// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector diagnostic lines persist for every run, not only failures.
 *
 * Connectors write technical detail through `connectorDiagnostic()`, which
 * writes `[<source>-diagnostic] <event> {json}` to stderr. Before this
 * change the runtime kept stderr only as a tail on `run.failed`, so a
 * completed run lost all of it. These tests pin:
 *
 *   1. The collector keeps only helper-prefixed lines, within bounds, and
 *      reports what it dropped.
 *   2. A completed run records a `run.connector_diagnostics_recorded`
 *      event, before its terminal event, on the owner run timeline.
 *   3. The persisted lines are redacted, including the run's own resolved
 *      credential matched by identity.
 *   4. A failed run records the event too, and a run with no diagnostic
 *      lines records nothing.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONNECTOR_DIAGNOSTIC_MAX_LINE_CHARS,
  createConnectorDiagnosticLineCollector,
  redactConnectorDiagnosticLine,
} from "../runtime/connector-diagnostic-lines.ts";
import { runConnector } from "../runtime/index.ts";
import { startServer } from "../server/index.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

// ─── 1. Collector ────────────────────────────────────────────────────────────

test("collector keeps only helper-prefixed lines, across chunk boundaries", () => {
  const collector = createConnectorDiagnosticLineCollector();
  collector.append("noise before\n[gmail-diagnostic] list_pa");
  collector.append(Buffer.from('ge {"status":429}\nTypeError: boom\n  at x (y.js:1)\n'));
  collector.append(
    "[runtime-diagnostic] lane_opened\r\n[not a diagnostic] x\n[spotify-diagnostic] tail_without_newline"
  );
  const out = collector.finalize();
  assert.deepEqual(out.lines, [
    '[gmail-diagnostic] list_page {"status":429}',
    "[runtime-diagnostic] lane_opened",
    "[spotify-diagnostic] tail_without_newline",
  ]);
  assert.equal(out.lines_observed, 3);
  assert.equal(out.truncated, false);
});

test("collector keeps multi-byte characters split across chunks", () => {
  const collector = createConnectorDiagnosticLineCollector();
  const bytes = Buffer.from("[x-diagnostic] café\n");
  collector.append(bytes.subarray(0, bytes.length - 2));
  collector.append(bytes.subarray(bytes.length - 2));
  assert.deepEqual(collector.finalize().lines, ["[x-diagnostic] café"]);
});

test("collector evicts the oldest lines past the line and byte bounds", () => {
  const byLines = createConnectorDiagnosticLineCollector({ maxLines: 3 });
  for (let i = 0; i < 10; i += 1) {
    byLines.append(`[x-diagnostic] event_${i}\n`);
  }
  const lineOut = byLines.finalize();
  assert.deepEqual(lineOut.lines, ["[x-diagnostic] event_7", "[x-diagnostic] event_8", "[x-diagnostic] event_9"]);
  assert.equal(lineOut.lines_observed, 10);
  assert.equal(lineOut.truncated, true);

  const byBytes = createConnectorDiagnosticLineCollector({ maxBytes: 100 });
  for (let i = 0; i < 10; i += 1) {
    byBytes.append(`[x-diagnostic] event_${i} ${"a".repeat(20)}\n`);
  }
  const byteOut = byBytes.finalize();
  assert.ok(byteOut.lines.join("").length <= 100, "kept bytes stay within the bound");
  assert.equal(byteOut.lines.at(-1), `[x-diagnostic] event_9 ${"a".repeat(20)}`);
  assert.equal(byteOut.truncated, true);
});

test("collector cuts an over-long line and does not buffer it without bound", () => {
  const collector = createConnectorDiagnosticLineCollector();
  collector.append(`[x-diagnostic] huge ${"z".repeat(CONNECTOR_DIAGNOSTIC_MAX_LINE_CHARS * 3)}`);
  collector.append(`${"z".repeat(CONNECTOR_DIAGNOSTIC_MAX_LINE_CHARS * 3)}\n[x-diagnostic] after\n`);
  const out = collector.finalize();
  assert.equal(out.lines.length, 2);
  assert.equal(out.lines[0]?.length, CONNECTOR_DIAGNOSTIC_MAX_LINE_CHARS);
  assert.ok(out.lines[0]?.endsWith("…"));
  assert.equal(out.lines[1], "[x-diagnostic] after");
  assert.equal(out.truncated, true);
});

test("redactor keeps long code slots and redacts data slots", () => {
  const secret = "Zq7tRm2k";
  const opaque = ["sk", "live", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"].join("_");
  const line = `[amazon-orders-history-diagnostic] attachment_hydration_skipped_budget ${JSON.stringify({
    accessToken: "abc",
    attachment_recovery_outcome: "skipped",
    footprint_bytes: 482_913,
    has_cookie: true,
    note: `retry with ${secret} and ${opaque}`,
    nested: { a: 1 },
  })}`;
  const out = redactConnectorDiagnosticLine(line, [secret]);
  assert.equal(out.redacted, true);
  assert.ok(out.text.startsWith("[amazon-orders-history-diagnostic] attachment_hydration_skipped_budget {"), out.text);
  const fields = JSON.parse(out.text.slice(out.text.indexOf("{"))) as Record<string, unknown>;
  assert.equal(fields.accessToken, "[REDACTED]");
  assert.equal(fields.attachment_recovery_outcome, "skipped");
  assert.equal(fields.footprint_bytes, 482_913);
  assert.equal(fields.has_cookie, true);
  assert.equal(fields.note, "retry with [REDACTED] and [REDACTED]");
  assert.equal(fields.nested, '{"a":1}');
});

test("redactor replaces code slots that carry a known secret or a bad shape", () => {
  const out = redactConnectorDiagnosticLine('[x-diagnostic] Zq7tRm2k_failed {"Zq7tRm2k":1,"a b":2}', ["Zq7tRm2k"]);
  assert.equal(out.text, '[x-diagnostic] [REDACTED] {"[REDACTED_KEY_0]":1,"[REDACTED_KEY_1]":2}');
  assert.equal(out.redacted, true);
  assert.deepEqual(redactConnectorDiagnosticLine("[x-diagnostic] plain_event", []), {
    redacted: false,
    text: "[x-diagnostic] plain_event",
  });
  assert.deepEqual(redactConnectorDiagnosticLine("[x-diagnostic] ev password=hunter2", []), {
    redacted: true,
    text: "[x-diagnostic] ev password=[REDACTED]",
  });
});

// ─── 2-4. Real runConnector + owner timeline ─────────────────────────────────

const STUB_MANIFEST = {
  connector_id: "https://registry.pdpp.dev/connectors/test-diagnostic-lines",
  display_name: "Diagnostic lines fixture",
  manifest_uri: "https://registry.pdpp.dev/connectors/test-diagnostic-lines",
  protocol_version: "0.1.0",
  runtime_requirements: {},
  streams: [
    {
      name: "noop",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "0.1.0",
};

type RuntimeManifest = Parameters<typeof runConnector>[0]["manifest"];

function runtimeManifest(): RuntimeManifest {
  return {
    ...STUB_MANIFEST,
    streams: STUB_MANIFEST.streams.map((stream) => {
      const { selection: _selection, ...withoutSelection } = stream;
      return withoutSelection;
    }),
  };
}

function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId);
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

// See connector-failure-diagnostics-control-plane.test.ts for why these
// members are declared here.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((r) => server.asServer.close(() => r())),
    new Promise<void>((r) => server.rsServer.close(() => r())),
  ]);
}

async function fetchJson<T>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: T | null }> {
  const resp = await fetch(url, opts);
  const parsed: unknown = await resp.json().catch(() => null);
  return { body: parsed as T | null, status: resp.status };
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  if (!device) {
    throw new Error("expected a device_authorization response body");
  }
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "owner_local", user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!tokenBody) {
    throw new Error("expected a token response body");
  }
  return tokenBody.access_token;
}

/**
 * A stub that writes `stderrText`, then either emits DONE succeeded and
 * exits 0, or exits 1 without DONE.
 */
function writeStub(stderrText: string, outcome: "completed" | "failed"): { tmpDir: string; stubPath: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-diag-lines-"));
  const stubPath = join(tmpDir, "stub.js");
  const finish =
    outcome === "completed"
      ? [
          `  process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 }) + "\\n");`,
          "  process.stdout.end(() => process.exit(0));",
        ]
      : ["  process.exit(1);"];
  const lines = [
    "#!/usr/bin/env node",
    "process.stdin.resume();",
    "process.stdin.once('data', () => {",
    `  process.stderr.write(${JSON.stringify(stderrText)});`,
    ...finish,
    "});",
    "",
  ];
  writeFileSync(stubPath, lines.join("\n"), "utf8");
  chmodSync(stubPath, 0o755);
  return { stubPath, tmpDir };
}

interface TimelineEvent {
  data: Record<string, unknown>;
  event_type: string;
}

const PLACEHOLDER_CONNECTION_PASSWORD = "Zq7tRm2k";

test("diagnostic lines persist on the owner timeline for completed and failed runs", async (t) => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  async function runStub(
    stderrText: string,
    outcome: "completed" | "failed",
    ownerToken: string
  ): Promise<{ runId: string; status: string | null }> {
    const { tmpDir, stubPath } = writeStub(stderrText, outcome);
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "full_refresh",
        connectorId: STUB_MANIFEST.connector_id,
        connectorPath: stubPath,
        manifest: runtimeManifest(),
        onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
        onProgress: () => {},
        ownerToken,
        rsUrl,
        state: null,
        staticSecretEnv: { TEST_STUB_PASSWORD: PLACEHOLDER_CONNECTION_PASSWORD },
      })) as { run_id: string; status: string };
      return { runId: result.run_id, status: result.status };
    } catch (err) {
      const runId = err && typeof err === "object" && "run_id" in err ? String(err.run_id) : "";
      return { runId, status: null };
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  }

  async function timeline(runId: string): Promise<TimelineEvent[]> {
    const { status, body } = await fetchJson<{ data?: TimelineEvent[]; events?: TimelineEvent[] }>(
      `${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`
    );
    assert.equal(status, 200);
    const events = Array.isArray(body?.data) ? body.data : body?.events;
    assert.ok(Array.isArray(events), "expected timeline events");
    return events;
  }

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(STUB_MANIFEST),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    await t.test("completed run: event recorded before run.completed, noise excluded, secrets redacted", async () => {
      const stderrText = [
        "some library warning",
        '[test-diagnostic-lines-diagnostic] page_fetched {"status":200,"items":12}',
        `[test-diagnostic-lines-diagnostic] login_retry {"user_hint":"${PLACEHOLDER_CONNECTION_PASSWORD}"}`,
        `[test-diagnostic-lines-diagnostic] header_seen token=${ownerToken}`,
        "",
      ].join("\n");
      const { runId, status } = await runStub(stderrText, "completed", ownerToken);
      assert.ok(runId, "expected a run_id");
      assert.equal(status, "succeeded");

      const events = await timeline(runId);
      const types = events.map((e) => e.event_type);
      const recordedAt = types.indexOf("run.connector_diagnostics_recorded");
      const completedAt = types.indexOf("run.completed");
      assert.ok(recordedAt >= 0, `expected run.connector_diagnostics_recorded in ${types.join(", ")}`);
      assert.ok(completedAt > recordedAt, "the terminal event stays last");

      const data = events[recordedAt]?.data ?? {};
      assert.equal(data.object, "connector_diagnostic_lines");
      assert.equal(data.visibility, "owner_local");
      assert.equal(data.lines_observed, 3);
      assert.equal(data.lines_kept, 3);
      assert.equal(data.truncated, false);
      assert.equal(data.redacted, true);
      const lines = data.lines as string[];
      assert.equal(lines[0], '[test-diagnostic-lines-diagnostic] page_fetched {"status":200,"items":12}');
      const serialized = JSON.stringify(lines);
      assert.ok(!serialized.includes("some library warning"), "non-diagnostic stderr is not persisted here");
      assert.ok(!serialized.includes(PLACEHOLDER_CONNECTION_PASSWORD), `credential leaked: ${serialized}`);
      assert.ok(!serialized.includes(ownerToken), `owner token leaked: ${serialized}`);
    });

    await t.test("failed run: event recorded alongside the stderr tail", async () => {
      const { runId } = await runStub("[test-diagnostic-lines-diagnostic] fatal_step\n", "failed", ownerToken);
      const events = await timeline(runId);
      const types = events.map((e) => e.event_type);
      const recordedAt = types.indexOf("run.connector_diagnostics_recorded");
      assert.ok(recordedAt >= 0 && types.indexOf("run.failed") > recordedAt, types.join(", "));
      assert.deepEqual(events[recordedAt]?.data.lines, ["[test-diagnostic-lines-diagnostic] fatal_step"]);
    });

    await t.test("run with no diagnostic lines records no event", async () => {
      const { runId, status } = await runStub("plain stderr only\n", "completed", ownerToken);
      assert.equal(status, "succeeded");
      const events = await timeline(runId);
      assert.ok(!events.some((e) => e.event_type === "run.connector_diagnostics_recorded"));
    });

    await t.test("grant-scoped /v1/search does not echo diagnostic lines", async () => {
      const { body } = await fetchJson<unknown>(`${asUrl}/v1/search?q=page_fetched`);
      const serialized = JSON.stringify(body ?? {});
      assert.ok(!serialized.includes("test-diagnostic-lines-diagnostic"), serialized.slice(0, 200));
    });
  } finally {
    await closeServer(server);
  }
});
