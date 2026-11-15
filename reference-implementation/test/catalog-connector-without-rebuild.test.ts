// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance: a connector in the signed catalog whose key no build of this
 * server has seen installs, validates, runs with its declared tuning
 * environment and gets a manifest-derived setup plan, with no rebuild and no
 * code change. `catalog-only-example` appears nowhere else in the repository.
 *
 * Each test guards one behavior from the era when the server consulted a
 * build-time list of connector keys:
 * - install + validation: a key outside the list had no tuning namespace, so
 *   a sibling manifest declaring another connector's knob was accepted, and
 *   the declared knob was not honored at spawn. The out-of-namespace
 *   rejection and the knob reaching the child both fail on that code.
 * - spawn: tuning bindings were kept only when a list lookup named this
 *   connector as the key's owner; a key outside the list owned nothing, so
 *   the child never saw PDPP_CATALOG_ONLY_EXAMPLE_PAGE_SIZE.
 * - setup plan: proof (`capabilities.proven.*`) was read from lists keyed by
 *   connector key, so a manifest's own claim changed nothing for a key
 *   outside them. The claimed-versus-unclaimed pair fails there.
 * - key identity: a pure-function pin that the key derives from the
 *   identifier alone. It already held before the list was deleted, so it
 *   documents the contract rather than catching that change.
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

test("install: the catalog connector installs through the real service and registers under its key", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pdpp-catalog-without-rebuild-"));
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
        writeFileSync(join(root, "dist", "collection-profile.mjs"), "export {};\n");
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

/** Spawn a capture child through runConnector and return the PDPP_* tuning keys it received. */
async function childTuningEnvironment(serverEnv: Record<string, string>): Promise<Record<string, string>> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-catalog-without-rebuild-spawn-"));
  const capturePath = join(tmpDir, "env.json");
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  const seen = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.endsWith('_PAGE_SIZE')));
  writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(seen));
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );
  const prior = Object.fromEntries(Object.keys(serverEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, serverEnv);
  initDb(":memory:");
  try {
    // Declares the foreign knob too: validation would reject it, and the
    // runtime must still not hand it to this connector.
    const runManifest = exampleManifest([OWN_KNOB, OTHER_KNOB]);
    const result = (await runConnector({
      admitRunConnection: ({ connectorId }: { connectorId: string }) =>
        Promise.resolve({ connectorId, connectorInstanceId: "cin_catalog", ownerSubjectId: "owner-1" }),
      connectorId: REGISTRY_ID,
      connectorInstanceId: "cin_catalog",
      connectorPath,
      manifest: runManifest as unknown as RuntimeRunConnectorOptions["manifest"],
      onInteraction: null,
      onProgress: () => undefined,
      ownerSubjectId: "owner-1",
      ownerToken: "test-token",
      persistState: false,
      state: null,
    } as unknown as RuntimeRunConnectorOptions)) as { status: string };
    assert.equal(result.status, "succeeded");
    return JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, string>;
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

test("spawn: the child receives its declared knob from the server environment and no other connector's", async () => {
  const env = await childTuningEnvironment({ [OWN_KNOB]: "25", [OTHER_KNOB]: "9", PDPP_STRAVA_PAGE_SIZE: "50" });
  assert.deepEqual(env, { [OWN_KNOB]: "25" });
});

test("setup plan: a proof claim in the manifest decides the path, the key does not", () => {
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
