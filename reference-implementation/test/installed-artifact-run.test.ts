// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End to end with a real published Collection Profile artifact.
 *
 * `test/fixtures/collection-profiles/artifacts/ical-0.1.0.tgz` holds the
 * installed layout (profile, bundled entrypoint, provenance, licences, assets)
 * of ghcr.io/pdp-connect/connector/ical 0.1.0, copied after the verified
 * installer (OCI + Sigstore) installed it. This test installs those bytes
 * through the real install service, checks they are byte-identical to the
 * signed artifact, and runs the bundled connector through the reference
 * runtime. Only the registry fetch and signature check are replaced; they need
 * network access to GHCR and Sigstore.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveActiveInstallFirstConnectorPath } from "../runtime/controller.ts";
import { getDb } from "../server/db.ts";
import {
  createConnectorInstallService,
  createFileConnectorInstallStore,
} from "../server/connector-install/index.ts";
import { createFileLocalConnectorSourceStore } from "../server/connector-install/local-source.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { resolveCredentialFreeFixtureRunEnv } from "./helpers/credential-free-run-fixture.ts";

const ARTIFACT = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "collection-profiles",
  "artifacts",
  "ical-0.1.0.tgz"
);

// Recorded by the verified installer for the signed ical 0.1.0 artifact.
const SIGNED = {
  configDigest: "sha256:e0c20b7d56ea863554554f0dc190afc438502d9f697091ff36cd06da8341edb7",
  digest: "sha256:37fd34b2aed46136955a340a080ba04e2706c2c92dd1590ff7e08e736c695047",
  entrypointSha256: "sha256:2c99ba939ce09616413c667e4d60b4084084c8f8eb7b10f8fde36434fead88c1",
  manifestSha256: "sha256:3d0429ef4d9d85eb8b7afd8b190c78412671d84e3162dadb06f446b5999760c7",
  provenanceSha256: "sha256:6e6b439e6bdb09ae876c53b07341ce8d4c6755b0e8adf035232757e7c61b6a8f",
} as const;

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//pdpp//installed artifact test//EN
BEGIN:VEVENT
UID:installed-artifact-1@example.invalid
DTSTAMP:20260901T120000Z
DTSTART:20260910T150000Z
DTEND:20260910T160000Z
SUMMARY:Synthetic event one
END:VEVENT
BEGIN:VEVENT
UID:installed-artifact-2@example.invalid
DTSTAMP:20260901T120000Z
DTSTART:20260911T150000Z
DTEND:20260911T153000Z
SUMMARY:Synthetic event two
END:VEVENT
END:VCALENDAR
`;

interface TestServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  schedulerManager?: { stop?: () => void };
}

const startServer = startServerUntyped as unknown as (opts: Record<string, unknown>) => Promise<TestServer>;

async function waitForTerminal(asUrl: string, runId: string): Promise<{ terminal_status?: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling is intentionally sequential
    const response = await fetch(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    const body = (await response.json()) as { terminal_status?: string };
    if (body.terminal_status) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

test("a real installed Collection Profile artifact runs through the reference runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-installed-artifact-run-"));
  const dataDir = join(dir, "installs");
  const importDir = join(dir, "ics");
  mkdirSync(importDir);
  writeFileSync(join(importDir, "calendar.ics"), ICS);
  const store = createFileConnectorInstallStore(dataDir);
  const localStore = createFileLocalConnectorSourceStore(dataDir);
  let server: TestServer | null = null;
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [
        {
          config_digest: SIGNED.configDigest,
          connector_id: "ical",
          connector_key: "ical",
          digest: SIGNED.digest,
          tier: "development",
          version: "0.1.0",
        },
      ],
      dataDir,
      installArtifact: (root) => {
        mkdirSync(root, { recursive: true });
        execFileSync("tar", ["-xzf", ARTIFACT, "-C", root]);
      },
      registerManifest: () => Promise.resolve(),
      store,
    });
    const record = await service.install("ical", SIGNED.digest);
    assert.equal(record.entrypointSha256, SIGNED.entrypointSha256, "entrypoint bytes match the signed artifact");
    assert.equal(record.manifestSha256, SIGNED.manifestSha256, "profile bytes match the signed artifact");
    assert.equal(record.provenanceSha256, SIGNED.provenanceSha256, "provenance bytes match the signed artifact");

    server = await startServer({
      asPort: 0,
      connectionScopedRunEnvResolver: resolveCredentialFreeFixtureRunEnv,
      connectorEnvironmentPolicy: JSON.stringify({
        bindings: [
          {
            connector_id: "ical",
            logical_key: "ICAL_IMPORT_DIR",
            source: { kind: "literal", value: importDir },
            target_key: "ICAL_IMPORT_DIR",
          },
        ],
      }),
      connectorPathResolver: (connectorId: string, manifest?: Record<string, unknown>) =>
        resolveActiveInstallFirstConnectorPath(connectorId, manifest, undefined, localStore, store),
      dbPath: ":memory:",
      quiet: true,
      rsPort: 0,
    });
    server.schedulerManager?.stop?.();
    const asUrl = `http://localhost:${server.asPort}`;

    const registered = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(record.manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registered.status, 201, "register the installed profile's manifest");

    const runResp = await fetch(`${asUrl}/_ref/connectors/ical/run`, { method: "POST" });
    assert.equal(runResp.status, 202);
    const { run_id: runId } = (await runResp.json()) as { run_id: string };
    const timeline = await waitForTerminal(asUrl, runId);
    assert.equal(timeline.terminal_status, "completed");

    const rows = getDb()
      .prepare("SELECT stream, COUNT(*) AS count FROM records WHERE connector_id = 'ical' GROUP BY stream")
      .all() as { count: number; stream: string }[];
    assert.deepEqual(rows, [{ count: 2, stream: "events" }], "the bundled connector ingested both events");
  } finally {
    if (server) {
      const s = server;
      s.asServer.closeAllConnections();
      s.rsServer.closeAllConnections();
      await Promise.allSettled([
        new Promise<void>((resolve) => s.asServer.close(resolve)),
        new Promise<void>((resolve) => s.rsServer.close(resolve)),
      ]);
    }
    rmSync(dir, { force: true, recursive: true });
  }
});
