// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance: a connector whose key no build of this server has seen installs
 * from a catalog entry, validates, runs with its declared tuning environment
 * and gets a manifest-derived setup plan, with no rebuild and no code change.
 * `catalog-only-example` appears nowhere else in the repository. The catalog
 * entry comes from an injected loader, so "in the signed catalog" is not
 * claimed here: see the last paragraph.
 *
 * What each test catches:
 * - validation: a key outside the old list had no tuning namespace, so a
 *   sibling manifest declaring another connector's knob was accepted. The
 *   out-of-namespace rejection fails on that code.
 * - spawn and install-and-run: tuning bindings were kept only when a list
 *   lookup named this connector as the key's owner, so the child never saw
 *   PDPP_CATALOG_ONLY_EXAMPLE_PAGE_SIZE. Install-and-run installs an
 *   executable through the real install service, registers its manifest
 *   through the server's validation, then runs that installed entrypoint with
 *   that registered manifest. The spawn test runs a hostile manifest that
 *   also declares a foreign knob.
 * - key identity and setup plan: contract pins. Both already held before the
 *   list was deleted, because the planner reads `capabilities.proven.*` from
 *   the manifest. They stop a later change from putting a list back; they do
 *   not catch the removal of the old one.
 *
 * The catalog loader and the artifact writer are injected, so this does not
 * exercise catalog signature verification, artifact download, or whether a
 * newly published catalog entry is picked up by a running server. The
 * production loader delegates to the pinned core's verified OCI catalog and
 * needs a signed catalog and a registry, so that path belongs in an
 * integration test, not in this unit-speed file.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type RuntimeRunConnectorOptions, runConnector } from "../runtime/index.ts";
import { getConnectorManifest } from "../server/auth.ts";
import { buildConnectionSetupPlan, type ConnectorManifestLike } from "../server/connection-setup-plan.ts";
import { canonicalConnectorKey, canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import {
  type ConnectorCatalogEntry,
  createConnectorInstallService,
  createFileConnectorInstallStore,
} from "../server/connector-install/index.ts";
import { installedConnectorManifestRegistration } from "../server/connector-install/manifest-registration.ts";
import { validateConnectorManifest } from "../server/connector-manifest-validation.ts";
import { closeDb, initDb } from "../server/db.ts";

const KEY = "catalog-only-example";
const REGISTRY_ID = `https://registry.pdpp.dev/connectors/${KEY}`;
const OWN_KNOB = "PDPP_CATALOG_ONLY_EXAMPLE_PAGE_SIZE";
const OTHER_KNOB = "PDPP_OTHER_THING_PAGE_SIZE";
// Not *_PAGE_SIZE: a leak of either would be invisible to a knob-only capture.
const FOREIGN_SECRET = "PDPP_OTHER_THING_TOKEN";
const UNDECLARED_OWN_SECRET = "PDPP_CATALOG_ONLY_EXAMPLE_TOKEN";
const SERVER_ENV = {
  [OWN_KNOB]: "25",
  [OTHER_KNOB]: "9",
  [FOREIGN_SECRET]: "foreign-secret",
  [UNDECLARED_OWN_SECRET]: "undeclared-secret",
  PDPP_STRAVA_PAGE_SIZE: "50",
};
const digest = `sha256:${"c".repeat(64)}`;
const configDigest = `sha256:${"d".repeat(64)}`;

function exampleManifest(tuningEnvironment: string[]): Record<string, unknown> {
  return {
    capabilities: {
      auth: { kind: "env", required: [] },
      public_listing: { tier: "supported" },
      refresh_policy: {
        background_safe: true,
        interaction_posture: "none",
        rationale: "Synthetic manifest for the catalog-without-rebuild acceptance test.",
        recommended_interval_seconds: 3600,
        recommended_mode: "automatic",
      },
    },
    connector_id: REGISTRY_ID,
    connector_key: KEY,
    display_name: "Catalog Only Example",
    manifest_uri: REGISTRY_ID,
    protocol_version: "0.1.0",
    runtime_requirements: { tuning_environment: tuningEnvironment },
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

test("key identity: the registry URL and the manifest both give the catalog key", () => {
  assert.equal(canonicalConnectorKey(REGISTRY_ID), KEY);
  assert.equal(canonicalConnectorKeyFromManifest(exampleManifest([OWN_KNOB])), KEY);
  assert.equal(canonicalConnectorKeyFromManifest({ connector_id: REGISTRY_ID }), KEY);
});

/** A connector executable that records every PDPP_* variable it was started with, then reports DONE. */
function captureScript(capturePath: string): string {
  return `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  const seen = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PDPP_')));
  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(seen));
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
});
`;
}

/** The runtime's own PDPP_* variables, plus the one declared knob and nothing else. */
function assertOnlyDeclaredKnob(seen: Record<string, string>): void {
  assert.deepEqual(seen, {
    PDPP_CONNECTOR_ID: KEY,
    PDPP_CONNECTOR_INSTANCE_ID: "cin_catalog",
    PDPP_OWNER_TOKEN: "test-token",
    PDPP_RS_URL: seen.PDPP_RS_URL,
    [OWN_KNOB]: "25",
  });
}

/**
 * Run `connectorPath` through runConnector with `serverEnv` applied to the
 * server's own environment, and return the capture file it wrote. The caller
 * owns the database and the capture path.
 */
async function runCapture(options: {
  capturePath: string;
  connectorPath: string;
  manifest: unknown;
  serverEnv: Record<string, string>;
}): Promise<Record<string, string>> {
  const prior = Object.fromEntries(Object.keys(options.serverEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, options.serverEnv);
  try {
    const result = (await runConnector({
      admitRunConnection: ({ connectorId }: { connectorId: string }) =>
        Promise.resolve({ connectorId, connectorInstanceId: "cin_catalog", ownerSubjectId: "owner-1" }),
      connectorId: REGISTRY_ID,
      connectorInstanceId: "cin_catalog",
      connectorPath: options.connectorPath,
      manifest: options.manifest as RuntimeRunConnectorOptions["manifest"],
      onInteraction: null,
      onProgress: () => undefined,
      ownerSubjectId: "owner-1",
      ownerToken: "test-token",
      persistState: false,
      state: null,
    } as unknown as RuntimeRunConnectorOptions)) as { status: string };
    assert.equal(result.status, "succeeded");
    return JSON.parse(readFileSync(options.capturePath, "utf8")) as Record<string, string>;
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("install and run: a connector from an injected catalog entry registers under its key and runs with its declared knob", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-catalog-without-rebuild-"));
  const capturePath = join(dataDir, "env.json");
  const entry: ConnectorCatalogEntry = {
    bindings: { network: "required" },
    config_digest: configDigest,
    connector_id: KEY,
    connector_key: KEY,
    digest,
    tier: "supported",
    version: "1.0.0",
  };
  initDb(":memory:");
  try {
    const service = createConnectorInstallService({
      catalogLoader: async () => [entry],
      dataDir,
      installArtifact: (root) => {
        mkdirSync(join(root, "profile"), { recursive: true });
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(join(root, "profile", "collection-profile.json"), JSON.stringify(exampleManifest([OWN_KNOB])));
        writeFileSync(join(root, "dist", "collection-profile.mjs"), captureScript(capturePath));
        writeFileSync(join(root, "provenance.json"), "{}\n");
      },
      // The real registration, so install runs the server's full manifest validation.
      registerManifest: installedConnectorManifestRegistration.registerManifest,
      store: createFileConnectorInstallStore(dataDir),
    });
    const active = await service.install(KEY, digest);
    assert.equal(active.digest, digest);

    const registered = await getConnectorManifest(KEY);
    assert.ok(registered, "the installed manifest is registered under the catalog key");
    assert.equal(canonicalConnectorKeyFromManifest(registered), KEY);
    assert.deepEqual((registered.runtime_requirements as { tuning_environment: string[] }).tuning_environment, [
      OWN_KNOB,
    ]);

    // Run what was installed: its entrypoint with its registered manifest.
    const seen = await runCapture({
      capturePath,
      connectorPath: join(active.root, active.entrypointPath),
      manifest: registered,
      serverEnv: SERVER_ENV,
    });
    assertOnlyDeclaredKnob(seen);
  } finally {
    closeDb();
    rmSync(dataDir, { force: true, recursive: true });
  }
});

test("validation: its own tuning namespace is accepted and another connector's is rejected", () => {
  assert.doesNotThrow(() => validateConnectorManifest(exampleManifest([OWN_KNOB])));
  assert.throws(
    () => validateConnectorManifest(exampleManifest([OTHER_KNOB])),
    /PDPP_OTHER_THING_PAGE_SIZE is outside the catalog-only-example tuning namespace/
  );
});

test("spawn: a foreign knob a manifest declares is not handed to the child, whoever declares it", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-catalog-without-rebuild-spawn-"));
  const capturePath = join(tmpDir, "env.json");
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(connectorPath, captureScript(capturePath), "utf8");
  initDb(":memory:");
  try {
    // Validation would reject the foreign knob; the runtime must drop it anyway.
    const seen = await runCapture({
      capturePath,
      connectorPath,
      manifest: exampleManifest([OWN_KNOB, OTHER_KNOB]),
      serverEnv: SERVER_ENV,
    });
    assertOnlyDeclaredKnob(seen);
  } finally {
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("setup plan (contract pin): a proof claim in the manifest decides the path, the key does not", () => {
  const base = exampleManifest([]) as unknown as ConnectorManifestLike;
  const local = { ...base, runtime_requirements: { bindings: { filesystem: { required: true } } } };

  const claimed = buildConnectionSetupPlan({
    connectorKey: KEY,
    manifest: { ...local, capabilities: { ...base.capabilities, proven: { local_collector: true } } },
  });
  assert.equal(claimed.connectorModality, "local_collector");
  assert.equal(claimed.catalogDisposition, "local_collector_enroll");
  assert.equal(claimed.supportState, "supported");

  const unclaimed = buildConnectionSetupPlan({ connectorKey: KEY, manifest: local });
  assert.equal(unclaimed.connectorModality, "local_collector");
  assert.equal(unclaimed.catalogDisposition, "local_collector_unproven");
  assert.notEqual(unclaimed.supportState, "supported");
});
