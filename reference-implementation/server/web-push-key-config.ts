// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createECDH } from "node:crypto"
import { resolveCredentialEncryptionKey } from "./stores/credential-encryption.ts"
import type { ProviderAppConfigStore } from "./stores/provider-app-config-store.ts"
import {
  resolveWebPushConfig,
  type WebPushConfig,
} from "./web-push-notifications.ts"

/** One sealed value keeps the public/private pair indivisible across concurrent starts. */
export async function resolvePersistentWebPushConfig({
  env = process.env,
  store,
}: {
  env?: NodeJS.ProcessEnv
  store: Pick<ProviderAppConfigStore, "getOrCreate">
}): Promise<WebPushConfig> {
  const explicit = resolveWebPushConfig(env)
  // A partially configured environment is an operator error: never mix pairs.
  if (explicit.publicKey || explicit.privateKey) return explicit
  let saved: string
  try {
    if (!resolveCredentialEncryptionKey(env)) return explicit
    saved = await store.getOrCreate({
      identityGroup: "dataconnect-notifications",
      logicalKey: "key-pair",
      create: () => {
        const key = createECDH("prime256v1")
        key.generateKeys()
        return JSON.stringify({
          publicKey: key.getPublicKey().toString("base64url"),
          privateKey: key.getPrivateKey().toString("base64url"),
        })
      },
    })
  } catch {
    // Losing the key provider must not rotate an existing pair or prevent startup.
    return explicit
  }
  const invalid: WebPushConfig = {
    enabled: false,
    privateKey: null,
    publicKey: null,
    subject: explicit.subject,
    unavailableReason: "Invalid stored web push key pair",
  }
  try {
    const pair: unknown = JSON.parse(saved)
    if (!pair || typeof pair !== "object" ||
      !("publicKey" in pair) || typeof pair.publicKey !== "string" || !pair.publicKey.trim() ||
      !("privateKey" in pair) || typeof pair.privateKey !== "string" || !pair.privateKey.trim()) return invalid
    return resolveWebPushConfig({
      ...env,
      PDPP_WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey,
      PDPP_WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey,
    })
  } catch {
    return invalid
  }
}
