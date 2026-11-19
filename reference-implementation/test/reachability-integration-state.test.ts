// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createGozar } from "@tnunamak/gozar";
import { ReachabilityOperations } from "../server/reachability/operations.ts";
import { loadHostIdentity } from "../server/reachability/identity.ts";
import { startServerReachability } from "../server/reachability/host.ts";
import { createSealedFileSecretBackend } from "../server/reachability/sealed-file-secret-backend.ts";
import { createCredentialCipher } from "../server/stores/credential-encryption.ts";
import fixture from "./fixtures/reachability/integration-0.4-state.json" with { type: "json" };

// Written by the integration build and Gozar 0.4.0 using synthetic providers and
// a test-only encryption key. No owner data is used. <HOME> relocates the fixture.
test("the server reads integration records and refuses incompatible configuration scopes", async () => {
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
      await assert.rejects(host.service.inventory(), { code: "configuration_migration_required" });
    } finally {
      host.service.closeObservers();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
