// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { normalizeConnectorManifestForStorage } from "../server/auth.ts";
import { createBrowserEnrollmentArtifactResolver } from "../server/browser-enrollment-artifact.ts";
import { browserEnrollmentSupport, buildConnectionSetupPlan } from "../server/connection-setup-plan.ts";
import { createConnectorInstallService, createFileConnectorInstallStore } from "../server/connector-install/index.ts";
import { createFileLocalConnectorSourceStore } from "../server/connector-install/local-source.ts";
import { BROWSER_BOUND_KEYS, FIRST_PARTY_CONNECTOR_KEYS } from "../server/generated/connector-registry.generated.ts";
import { withFixtureSourceDeclaration } from "./helpers/fixture-source-declaration.ts";

test("selected local bytes control enrollment; missing, changed and nonbrowser artifacts refuse", async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "enrollment-artifact-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  await Promise.all(
    ["chatgpt", "whoop", "book-shelf", "anthropic", "spotify"].map(async (key) => {
      const store = createFileLocalConnectorSourceStore(join(root, `${key}-owner`));
      const resolve = createBrowserEnrollmentArtifactResolver({ status: () => Promise.resolve([]) }, store);
      const artifactRoot = join(root, key);
      mkdirSync(join(artifactRoot, "profile"), { recursive: true });
      mkdirSync(join(artifactRoot, "dist"));
      const {
        setup: _setup,
        capabilities: { auth: _auth, proven: _proven, ...capabilities },
        ...manifest
      } = JSON.parse(readFileSync(new URL("./fixtures/collection-profiles/github.json", import.meta.url), "utf8"));
      manifest.connector_id = `https://vendor.example/connectors/${key}`;
      manifest.manifest_uri = manifest.connector_id;
      manifest.connector_key = key;
      manifest.capabilities = capabilities;
      manifest.runtime_requirements = { bindings: { [key === "spotify" ? "network" : "browser"]: { required: true } } };
      const profile = withFixtureSourceDeclaration(manifest);
      const registered = normalizeConnectorManifestForStorage(profile).storedManifest;
      writeFileSync(join(artifactRoot, "profile/collection-profile.json"), JSON.stringify(profile));
      const entrypoint = join(artifactRoot, "dist/collection-profile.mjs");
      writeFileSync(entrypoint, "export default {};\n");
      const source = await store.add(artifactRoot);
      assert.equal((await resolve(key, registered)).status, "none");
      await store.select(key, source.sourceId);
      const evidence = await resolve(key, registered);
      assert.equal(evidence.status, "verified");
      assert.equal((await resolve(key, { ...registered, version: "stale-registration" })).status, "invalid");
      const enriched = { ...registered, browser_enrollment_artifact: evidence };
      const support = browserEnrollmentSupport(key, enriched);
      assert.equal(support.canAddAccount, key !== "anthropic" && key !== "spotify");
      assert.equal(support.browserBound, key !== "spotify");
      assert.equal(
        buildConnectionSetupPlan({ connectorKey: key, manifest: enriched }).catalogDisposition ===
          "browser_collector_manual",
        support.canAddAccount
      );
      writeFileSync(entrypoint, "export default { changed: true };\n");
      const tampered = await resolve(key, registered);
      assert.equal(tampered.status, "invalid");
      assert.equal(
        browserEnrollmentSupport(key, { ...registered, browser_enrollment_artifact: tampered }).canAddAccount,
        false
      );
    })
  );
  const resolveMissing = createBrowserEnrollmentArtifactResolver(
    { status: () => Promise.resolve([]) },
    createFileLocalConnectorSourceStore(join(root, "missing-owner"))
  );
  assert.equal((await resolveMissing("unregistered", {})).status, "none");
});

test("installed artifact inspection is keyed, rejects drift, and never overrides a broken selected local source", async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "enrollment-installed-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const localStore = createFileLocalConnectorSourceStore(root);
  const {
    setup: _setup,
    capabilities: { auth: _auth, proven: _proven, ...capabilities },
    ...manifest
  } = JSON.parse(readFileSync(new URL("./fixtures/collection-profiles/github.json", import.meta.url), "utf8"));
  const connectorKey = "goodreads404";
  assert.equal(FIRST_PARTY_CONNECTOR_KEYS.includes(connectorKey), false);
  assert.equal(BROWSER_BOUND_KEYS.includes(connectorKey), false);
  manifest.connector_id = `https://registry.pdpp.dev/connectors/${connectorKey}`;
  manifest.connector_key = connectorKey;
  manifest.manifest_uri = `https://registry.pdpp.dev/connectors/${connectorKey}`;
  manifest.capabilities = capabilities;
  manifest.runtime_requirements = { bindings: { browser: { required: true } } };
  const profile = withFixtureSourceDeclaration(manifest);
  const registered = normalizeConnectorManifestForStorage(profile).storedManifest;
  const digest = `sha256:${"a".repeat(64)}`;
  const writePayload = (target: string) => {
    mkdirSync(join(target, "profile"), { recursive: true });
    mkdirSync(join(target, "dist"));
    writeFileSync(join(target, "profile/collection-profile.json"), JSON.stringify(profile));
    writeFileSync(join(target, "dist/collection-profile.mjs"), "export {};\n");
    writeFileSync(join(target, "provenance.json"), "{}\n");
  };
  const service = createConnectorInstallService({
    catalogLoader: () =>
      Promise.resolve([
        {
          config_digest: `sha256:${"b".repeat(64)}`,
          connector_id: connectorKey,
          connector_key: connectorKey,
          digest,
          tier: "preview",
          version: "1.0.0",
        },
      ]),
    dataDir: root,
    installArtifact: writePayload,
    localSourceStore: localStore,
    registerManifest: () => Promise.resolve(),
    store: createFileConnectorInstallStore(root),
  });
  const active = await service.install(connectorKey, digest);
  const resolve = createBrowserEnrollmentArtifactResolver(
    {
      ...service,
      status: () => {
        throw new Error("Enrollment must not enumerate all installed artifacts");
      },
    },
    localStore
  );
  const installedEvidence = await resolve(connectorKey, registered);
  assert.equal(installedEvidence.status, "verified");
  assert.equal(
    browserEnrollmentSupport(connectorKey, { ...registered, browser_enrollment_artifact: installedEvidence })
      .canAddAccount,
    true
  );
  assert.equal((await resolve(connectorKey, { ...registered, version: "stale" })).status, "invalid");
  const localRoot = join(root, "local");
  writePayload(localRoot);
  const source = await localStore.add(localRoot);
  await localStore.select(connectorKey, source.sourceId);
  writeFileSync(join(localRoot, "dist/collection-profile.mjs"), "changed local\n");
  assert.equal((await resolve(connectorKey, registered)).status, "invalid");
  await localStore.select(connectorKey, null);
  writeFileSync(join(active.root, active.entrypointPath), "changed installed\n");
  assert.equal((await resolve(connectorKey, registered)).status, "invalid");
});
