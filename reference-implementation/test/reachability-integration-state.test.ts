// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ReachabilityService } from "../server/reachability/service.ts";
import { projectInventory, projectRoute } from "../server/reachability/projection.ts";
import { createGozar } from "@tnunamak/gozar";
import { ReachabilityOperations } from "../server/reachability/operations.ts";
import { loadHostIdentity } from "../server/reachability/identity.ts";
import { startServerReachability } from "../server/reachability/host.ts";
import { createSealedFileSecretBackend } from "../server/reachability/sealed-file-secret-backend.ts";
import { createCredentialCipher } from "../server/stores/credential-encryption.ts";
import fixture from "./fixtures/reachability/integration-0.4-state.json" with { type: "json" };

// Written by the integration build and Gozar 0.4.0 using synthetic providers and
// a test-only encryption key. No owner data is used. <HOME> relocates the fixture.
test("undeclared legacy scopes are retained while the SDK permits fresh setup", async () => {
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
      assert.ok(projectInventory(inventory).providers.length > 0);
      // Exercise fresh setup after boot reconciliation, without probing the
      // fixture's old routes or invoking any provider effects.
      const service = new ReachabilityService(api, {
        identity, hostCapabilities: {},
        acknowledgeDisconnect: async () => undefined, prepare: async () => undefined,
        query: { schemaVersion: 1, home, owner: "pdpp-reference-server", target: "127.0.0.1:7663",
          requirements: { address: "any", reach: "internet", transport: "https", protocols: [], payloadAccess: "allow-provider", setup: "allow" } },
      });
      const before = JSON.parse(readFileSync(join(home, "embedding-state.json"), "utf8"));
      const provider = (await service.inventory()).providers.find(provider => provider.providerId === "own-address")!;
      assert.notEqual(provider.configuration.known, false);
      if (provider.configuration.known === false) throw new Error("fixture blocked");
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
      assert.ok((await service.inventory()).providers.length > 0);
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


test("route cleanup projects app copy without SDK instructions or changing binding remedies", () => {
  const instructions = "Call closeRoute again with the retained route handle (session).";
  const remedyInstructions = "Copy the provider verification value exactly.";
  const action = { id: "retry-close", label: "SDK instruction", instructions,
    disclosure: { links: [], revision: "fixture", text: "Fixture" } };
  const unresolved = { known: false, reason: "not-observed" };
  const route = {
    binding: { target: unresolved, remedy: { ...action, id: "provider-remedy", instructions: remedyInstructions } },
    cleanup: { state: "unconfirmed", nextAction: action },
    expiresAt: unresolved,
    facts: [],
    handle: { generation: 1, id: "fixture", kind: "session" },
    hostConfiguration: { target: unresolved, localPort: unresolved, bindTarget: unresolved, origin: unresolved },
    verification: { results: [], validUntil: unresolved },
  } as unknown as Parameters<typeof projectRoute>[0];

  const projected = projectRoute(route);
  assert.deepEqual(projected.cleanup, {
    state: "unconfirmed", nextAction: { id: "retry-route-cleanup", label: "Turn off again" },
  });
  assert.equal(projected.binding.remedy?.instructions, remedyInstructions);
  assert.doesNotMatch(JSON.stringify(projected), /closeRoute|retained route handle/);

  const other = projectRoute({ ...route, cleanup: {
    ...route.cleanup, nextAction: { ...route.cleanup.nextAction!, id: "fixture-cleanup-code" },
  } });
  assert.deepEqual(other.cleanup.nextAction, {
    id: "retry-route-cleanup", label: "Turn off again", supportCode: "fixture-cleanup-code",
  });
  assert.doesNotMatch(JSON.stringify(other), /closeRoute|retained route handle/);
});
