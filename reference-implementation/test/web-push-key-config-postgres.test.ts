// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import test from "node:test"
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.ts"
import { createPostgresProviderAppConfigStore } from "../server/stores/provider-app-config-store.ts"
import { resolvePersistentWebPushConfig } from "../server/web-push-key-config.ts"
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts"
const databaseUrl = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL)
test(
  "PostgreSQL notification keys survive restart; concurrent starts agree; environment wins",
  {
    skip: databaseUrl
      ? false
      : "dedicated PostgreSQL test listener not supplied",
  },
  async () => {
    assert.ok(databaseUrl)
    const env = { PDPP_CREDENTIAL_ENCRYPTION_KEY: "practice-encryption-key" }
    const config = { backend: "postgres" as const, databaseUrl }
    await initPostgresStorage(config)
    try {
      await postgresQuery(
        "DELETE FROM provider_app_config WHERE identity_group = $1",
        ["dataconnect-notifications"]
      )
      const configs = await Promise.all(
        Array.from({ length: 3 }, () =>
          resolvePersistentWebPushConfig({
            env,
            store: createPostgresProviderAppConfigStore({ env }),
          })
        )
      )
      const first = configs[0]!
      assert.equal(first.enabled, true)
      assert.ok(
        configs.every(
          config =>
            config.publicKey === first.publicKey &&
            config.privateKey === first.privateKey
        )
      )
      const sealed = await postgresQuery<{ sealed_value: string }>(
        "SELECT sealed_value FROM provider_app_config WHERE identity_group = $1",
        ["dataconnect-notifications"]
      )
      assert.ok(!sealed.rows[0]!.sealed_value.includes(first.privateKey!))
      await closePostgresStorage()
      await initPostgresStorage(config)
      const again = await resolvePersistentWebPushConfig({
        env,
        store: createPostgresProviderAppConfigStore({ env }),
      })
      assert.equal(again.publicKey, first.publicKey)
      assert.equal(again.privateKey, first.privateKey)
      const explicit = await resolvePersistentWebPushConfig({
        env: {
          ...env,
          PDPP_WEB_PUSH_VAPID_PUBLIC_KEY: "explicit",
          PDPP_WEB_PUSH_VAPID_PRIVATE_KEY: "explicit-private",
        },
        store: createPostgresProviderAppConfigStore({ env }),
      })
      assert.equal(explicit.publicKey, "explicit")
    } finally {
      await postgresQuery(
        "DELETE FROM provider_app_config WHERE identity_group = $1",
        ["dataconnect-notifications"]
      )
      await closePostgresStorage()
    }
  }
)
