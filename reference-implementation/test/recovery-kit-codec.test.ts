// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  decodeRecoveryKitV2,
  encodeRecoveryKitV2,
  RECOVERY_KIT_MAX_KEY_BYTES,
  RecoveryKitCodecError,
} from "../server/recovery-kit-codec.ts"

test("v2 recovery-kit code round-trips database and credential-vault keys", () => {
  const code = encodeRecoveryKitV2({
    credentialEncryptionKey: "credential-vault-key",
    databaseEncryptionKey: "sqlite-db-key",
  })

  assert.match(code, /^[0-9A-F]{4}(?:-[0-9A-F]{4})*-?[0-9A-F]*$/u)
  assert.deepEqual(decodeRecoveryKitV2(code), {
    credentialEncryptionKey: "credential-vault-key",
    databaseEncryptionKey: "sqlite-db-key",
  })
})

test("v2 recovery-kit code allows an omitted database key", () => {
  const decoded = decodeRecoveryKitV2(
    encodeRecoveryKitV2({
      credentialEncryptionKey: "credential-vault-key",
      databaseEncryptionKey: null,
    })
  )

  assert.equal(decoded.databaseEncryptionKey, null)
  assert.equal(decoded.credentialEncryptionKey, "credential-vault-key")
})

test("v2 recovery-kit code preserves a leading byte-order mark in key material", () => {
  const code = encodeRecoveryKitV2({
    credentialEncryptionKey: "\uFEFFcredential-vault-key",
    databaseEncryptionKey: "\uFEFFsqlite-db-key",
  })

  assert.deepEqual(decodeRecoveryKitV2(code), {
    credentialEncryptionKey: "\uFEFFcredential-vault-key",
    databaseEncryptionKey: "\uFEFFsqlite-db-key",
  })
})

test("v2 recovery-kit decode accepts whitespace, lowercase, and changed grouping", () => {
  const code = encodeRecoveryKitV2({
    credentialEncryptionKey: "credential-vault-key",
    databaseEncryptionKey: "sqlite-db-key",
  })
  const regrouped = code.replaceAll("-", "").toLowerCase().replace(/(.{8})/gu, "$1 ")

  assert.deepEqual(decodeRecoveryKitV2(regrouped), {
    credentialEncryptionKey: "credential-vault-key",
    databaseEncryptionKey: "sqlite-db-key",
  })
})

test("v2 recovery-kit decode rejects checksum failures", () => {
  const code = encodeRecoveryKitV2({
    credentialEncryptionKey: "credential-vault-key",
    databaseEncryptionKey: "sqlite-db-key",
  })
  const mutated = `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`

  assert.throws(
    () => decodeRecoveryKitV2(mutated),
    (err) => err instanceof RecoveryKitCodecError && err.code === "recovery_kit_checksum_mismatch"
  )
})

test("v2 recovery-kit decode caps untrusted input size before allocation", () => {
  assert.throws(
    () => decodeRecoveryKitV2("A".repeat(8_194)),
    (err) => err instanceof RecoveryKitCodecError && err.code === "recovery_kit_too_large"
  )
})

test("v2 recovery-kit encode requires the credential-vault key", () => {
  assert.throws(
    () => encodeRecoveryKitV2({ credentialEncryptionKey: "", databaseEncryptionKey: "sqlite-db-key" }),
    (err) => err instanceof RecoveryKitCodecError && err.code === "recovery_kit_key_invalid"
  )
})

test("v2 recovery-kit encode rejects a key that would exceed the decoder size cap", () => {
  assert.throws(
    () =>
      encodeRecoveryKitV2({
        credentialEncryptionKey: "x".repeat(RECOVERY_KIT_MAX_KEY_BYTES + 1),
        databaseEncryptionKey: "sqlite-db-key",
      }),
    (err) => err instanceof RecoveryKitCodecError && err.code === "recovery_kit_key_too_long"
  )
})

test("v2 recovery-kit max-size encode output remains decodable", () => {
  const code = encodeRecoveryKitV2({
    credentialEncryptionKey: "c".repeat(RECOVERY_KIT_MAX_KEY_BYTES),
    databaseEncryptionKey: "d".repeat(RECOVERY_KIT_MAX_KEY_BYTES),
  })

  assert.ok(code.replaceAll("-", "").length <= 8_192)
  assert.deepEqual(decodeRecoveryKitV2(code), {
    credentialEncryptionKey: "c".repeat(RECOVERY_KIT_MAX_KEY_BYTES),
    databaseEncryptionKey: "d".repeat(RECOVERY_KIT_MAX_KEY_BYTES),
  })
})

test("v2 recovery-kit decode rejects non-UTF-8 key bytes", () => {
  const payload = Buffer.from([2, 0, 0, 0, 1, 0xff])
  const checksum = createHash("sha256").update(payload).digest().subarray(0, 2)
  const code = Buffer.concat([payload, checksum]).toString("hex")

  assert.throws(
    () => decodeRecoveryKitV2(code),
    (err) => err instanceof RecoveryKitCodecError && err.code === "recovery_kit_invalid_utf8"
  )
})
