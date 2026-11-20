// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readEarlierSetup } from "../server/reachability/configuration-compatibility.ts";
import { ReachabilityService } from "../server/reachability/service.ts";
import { projectInventory } from "../server/reachability/projection.ts";
import { createGozar } from "@tnunamak/gozar";
import { ReachabilityOperations } from "../server/reachability/operations.ts";
import { loadHostIdentity } from "../server/reachability/identity.ts";
import { startServerReachability } from "../server/reachability/host.ts";
import { createSealedFileSecretBackend } from "../server/reachability/sealed-file-secret-backend.ts";
import { createCredentialCipher } from "../server/stores/credential-encryption.ts";
import fixture from "./fixtures/reachability/integration-0.4-state.json" with { type: "json" };

// Written by the integration build and Gozar 0.4.0 using synthetic providers and
// a test-only encryption key. No owner data is used. <HOME> relocates the fixture.
test("the integration setup is retained while fresh setup proceeds with a reentry notice", async () => {
  const root = mkdtempSync(join(tmpdir(), "ra-upgrade-"));
  const home = join(root, "reachability-home");
  try {
    for (const [name, value] of Object.entries(fixture.files)) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, value.replaceAll("<HOME>", home), { mode: 0o600 });
    }
    const journal = new ReachabilityOperations(join(root, "reachability-operations"), true);
    const record = await journal.read(fixture.journalOperationId);
    assert.equal(record.stopTombstone, true);
    assert.equal(record.cleanupConfirmed, undefined);
    assert.deepEqual(record.handle, { kind: "attached", id: "fixture-attached", generation: 1 });
    const identity = loadHostIdentity(join(root, "reachability"));
    assert.equal(identity.instanceId, fixture.identity.instanceId);
    assert.notEqual(identity.bootId, fixture.identity.bootId);
    const backend = createSealedFileSecretBackend(join(root, "reachability-secrets"), () => createCredentialCipher("integration-fixture-key"));
    assert.equal(await backend.withSecret({ handle: fixture.secretHandle, scopeId: "fixture-scope" }, async bytes => new TextDecoder().decode(bytes)), "fixture-secret");
    const api = createGozar({ identity, secretBackend: backend, hostCapabilities: {} });
    const listed = await api.listRoutes({ home, owner: "pdpp-reference-server" });
    assert.deepEqual(listed.routes.map(route => route.handle.kind).sort(), ["durable", "external"]);
    assert.ok(listed.routes.every(route => route.operationId?.startsWith("fixture-")));
    const host = await startServerReachability({
      dataDir: root, env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: "integration-fixture-key" },
      bindHost: "127.0.0.1", rsPort: 7663, owner: "login-subject", passwordConfigured: true,
    });
    assert.ok(host?.service);
    try {
      const inventory = await host.service.inventory();
      assert.equal(inventory.earlierSetup, "needs_reentry");
      assert.equal(host.service.state().earlierSetup, "needs_reentry");
      assert.equal(projectInventory(inventory).earlierSetup, "needs_reentry");
      // Exercise fresh setup after boot reconciliation, without probing the
      // fixture's old routes or invoking any provider effects.
      const service = new ReachabilityService(api, {
        identity, hostCapabilities: {},
        readEarlierSetup: scopes => readEarlierSetup(home, scopes),
        acknowledgeDisconnect: async () => undefined, prepare: async () => undefined,
        query: { schemaVersion: 1, home, owner: "pdpp-reference-server", target: "127.0.0.1:7663",
          requirements: { address: "any", reach: "internet", transport: "https", protocols: [], payloadAccess: "allow-provider", setup: "allow" } },
      });
      const before = JSON.parse(readFileSync(join(home, "embedding-state.json"), "utf8"));
      const provider = (await service.inventory()).providers.find(provider => provider.providerId === "own-address")!;
      const draft = await service.begin(provider.providerId, provider.configuration.revision);
      assert.ok(draft.draftId);
      const action = draft.configuration.actions.find(action => action.kind === "provide-value")!;
      assert.ok(action.consent);
      const configured = await service.setup(draft.draftId, {
        actionId: action.id, expectedRevision: draft.configuration.revision, value: "https://reentered.invalid",
        approval: { kind: "setup", digest: action.digest, disclosureRevision: action.disclosure.revision,
          consentFactsDigest: action.consent.consentFactsDigest },
      });
      await service.commit(draft.draftId, configured.revision);
      assert.equal((await service.inventory()).earlierSetup, null);
      assert.equal(service.state().earlierSetup, null);
      const after = JSON.parse(readFileSync(join(home, "embedding-state.json"), "utf8"));
      for (const [scope, config] of Object.entries(before.configs)) {
        if (scope !== draft.scopeId) assert.deepEqual(after.configs[scope], config, "earlier scopes remain intact");
      }
      service.closeObservers();
    } finally {
      host.service.closeObservers();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("the earlier-setup reader is read-only and clears only for saved current configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "ra-earlier-setup-"));
  const path = join(root, "embedding-state.json");
  const old = { values: { origin: "https://fixture.invalid" }, bindings: {}, drafts: {}, uses: [] };
  try {
    assert.equal(await readEarlierSetup(root, []), null);
    const original = JSON.stringify({ schemaVersion: 1, configs: { old, current: { values: {}, bindings: {}, drafts: {} } } });
    writeFileSync(path, original);
    assert.equal(await readEarlierSetup(root, ["current"]), "needs_reentry");
    assert.equal(readFileSync(path, "utf8"), original);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, configs: { old, current: { values: { origin: "https://reentered.invalid" } } } }));
    assert.equal(await readEarlierSetup(root, ["current"]), null);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, configs: { old: { drafts: { draft: { values: { origin: "https://fixture.invalid" } } } } } }));
    assert.equal(await readEarlierSetup(root, []), "needs_reentry");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unreadable or corrupt embedding state still refuses setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "ra-corrupt-setup-"));
  const path = join(root, "embedding-state.json");
  try {
    mkdirSync(path);
    await assert.rejects(readEarlierSetup(root, []), { code: "configuration_migration_required" });
    rmSync(path, { recursive: true });
    for (const state of ["{", "null", JSON.stringify({ schemaVersion: 2, configs: {} }), JSON.stringify({ schemaVersion: 1, configs: [] })]) {
      writeFileSync(path, state);
      await assert.rejects(readEarlierSetup(root, []), { code: "configuration_migration_required" });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
