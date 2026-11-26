// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { closeDb, initDb } from "../server/db.ts"
import { createSqliteProviderAppConfigStore } from "../server/stores/provider-app-config-store.ts"
import { resolvePersistentWebPushConfig } from "../server/web-push-key-config.ts"

test("notification key pair persists across store recreation and environment wins", async () => {
  const tempRoot = join(homedir(), ".tmp")
  mkdirSync(tempRoot, { recursive: true })
  const directory = mkdtempSync(join(tempRoot, "notification-key-test-"))
  const path = join(directory, "test.db")
  initDb(path)
  const env = { PDPP_CREDENTIAL_ENCRYPTION_KEY: "practice-encryption-key" }
  try {
    const first = await resolvePersistentWebPushConfig({
      env,
      store: createSqliteProviderAppConfigStore({ env }),
    })
    assert.equal(first.enabled, true)
    closeDb()
    initDb(path)
    const again = await resolvePersistentWebPushConfig({
      env,
      store: createSqliteProviderAppConfigStore({ env }),
    })
    assert.equal(again.publicKey, first.publicKey)
    assert.equal(again.privateKey, first.privateKey)
    const explicit = {
      ...env,
      PDPP_WEB_PUSH_VAPID_PUBLIC_KEY: "explicit-public",
      PDPP_WEB_PUSH_VAPID_PRIVATE_KEY: "explicit-private",
    }
    assert.equal(
      (
        await resolvePersistentWebPushConfig({
          env: explicit,
          store: createSqliteProviderAppConfigStore({ env }),
        })
      ).publicKey,
      "explicit-public"
    )
    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () =>
        resolvePersistentWebPushConfig({
          env,
          store: createSqliteProviderAppConfigStore({ env }),
        })
      )
    )
    assert.ok(concurrent.every(config => config.publicKey === first.publicKey))
  } finally {
    closeDb()
    rmSync(directory, { recursive: true, force: true })
  }
})
test("no encryption key leaves notifications unavailable without storing plaintext", async () => {
  initDb(":memory:")
  try {
    assert.equal(
      (
        await resolvePersistentWebPushConfig({
          env: {},
          store: createSqliteProviderAppConfigStore({ env: {} }),
        })
      ).enabled,
      false
    )
  } finally {
    closeDb()
  }
})

test("lock screen words contain no protocol or private interaction content", async () => {
  const { buildTestPushPayload, buildPendingInteractionPushPayload, buildEscalationPushPayload } = await import("../server/web-push-notifications.ts");
  const pending = buildPendingInteractionPushPayload({ connectorDisplayName: "Reading list", interaction: { kind: "credentials", message: "private value" }, runId: "practice" });
  assert.equal(pending.title, "Reading list needs you");
  assert.equal(pending.body, "Open DataConnect to finish signing in.");
  const waiting = buildEscalationPushPayload({ connectorDisplayName: "Reading list", reason: "blocked" });
  assert.equal(waiting.title, "Reading list needs you");
  assert.equal(waiting.body, "Open DataConnect to continue this sync.");
  const trial = buildTestPushPayload();
  assert.equal(trial.title, "DataConnect");
  assert.equal(trial.body, "This is a test. Notifications work on this device.");
  for (const payload of [pending, waiting, trial]) assert.doesNotMatch(`${payload.title} ${payload.body}`, /PDPP|owner|connector|private value/);
});
