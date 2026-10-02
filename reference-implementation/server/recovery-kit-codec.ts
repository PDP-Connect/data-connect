// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto"
import { TextDecoder } from "node:util"

const RECOVERY_KIT_VERSION = 2
const CHECKSUM_BYTES = 2
const GROUP_LEN = 4
const MAX_ENCODED_CHARS = 8_192
const MAX_ENCODED_BYTES = MAX_ENCODED_CHARS / 2
const FIXED_BYTES = 1 + 2 + 2 + CHECKSUM_BYTES
export const RECOVERY_KIT_MAX_KEY_BYTES = Math.floor((MAX_ENCODED_BYTES - FIXED_BYTES) / 2)
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

export interface RecoveryKitV2 {
  readonly credentialEncryptionKey: string
  readonly databaseEncryptionKey: string | null
}

export class RecoveryKitCodecError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "RecoveryKitCodecError"
    this.code = code
  }
}

function checksum(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest().subarray(0, CHECKSUM_BYTES)
}

function encodeKey(key: string | null, label: string, required: boolean): Buffer {
  if (key === null) {
    if (required) {
      throw new RecoveryKitCodecError("recovery_kit_key_required", `${label} is required.`)
    }
    return Buffer.alloc(0)
  }
  if (typeof key !== "string" || key.length === 0) {
    throw new RecoveryKitCodecError("recovery_kit_key_invalid", `${label} must be a non-empty string.`)
  }
  const bytes = Buffer.from(key, "utf8")
  if (bytes.length > RECOVERY_KIT_MAX_KEY_BYTES) {
    throw new RecoveryKitCodecError("recovery_kit_key_too_long", `${label} exceeds the v2 recovery-kit key length limit.`)
  }
  return bytes
}

function encodeLengthPrefixed(bytes: Buffer): Buffer {
  const prefix = Buffer.alloc(2)
  prefix.writeUInt16BE(bytes.length, 0)
  return Buffer.concat([prefix, bytes])
}

function groupedUpperHex(bytes: Buffer): string {
  const hex = bytes.toString("hex").toUpperCase()
  return hex.match(new RegExp(`.{1,${GROUP_LEN}}`, "gu"))?.join("-") ?? ""
}

export function encodeRecoveryKitV2(input: RecoveryKitV2): string {
  const dbKey = encodeKey(input.databaseEncryptionKey, "Database encryption key", false)
  const credentialKey = encodeKey(input.credentialEncryptionKey, "Credential encryption key", true)
  const body = Buffer.concat([
    Buffer.from([RECOVERY_KIT_VERSION]),
    encodeLengthPrefixed(dbKey),
    encodeLengthPrefixed(credentialKey),
  ])
  return groupedUpperHex(Buffer.concat([body, checksum(body)]))
}

function readLengthPrefixed(payload: Buffer, offset: number, label: string): { bytes: Buffer; offset: number } {
  if (offset + 2 > payload.length) {
    throw new RecoveryKitCodecError("recovery_kit_truncated", `${label} length is missing.`)
  }
  const length = payload.readUInt16BE(offset)
  const start = offset + 2
  const end = start + length
  if (end > payload.length) {
    throw new RecoveryKitCodecError("recovery_kit_truncated", `${label} bytes are incomplete.`)
  }
  return { bytes: payload.subarray(start, end), offset: end }
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new RecoveryKitCodecError("recovery_kit_invalid_utf8", `${label} is not valid UTF-8.`)
  }
}

export function decodeRecoveryKitV2(code: string): RecoveryKitV2 {
  const cleaned = code
    .replace(/[\s-]/gu, "")
    .toUpperCase()
  if (cleaned.length === 0) {
    throw new RecoveryKitCodecError("recovery_kit_empty", "Recovery kit code is empty.")
  }
  if (cleaned.length > MAX_ENCODED_CHARS) {
    throw new RecoveryKitCodecError("recovery_kit_too_large", "Recovery kit code is too large.")
  }
  if (!/^[0-9A-F]+$/u.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new RecoveryKitCodecError("recovery_kit_invalid_hex", "Recovery kit code contains invalid hex.")
  }
  const bytes = Buffer.from(cleaned, "hex")
  if (bytes.length < 1 + 2 + 2 + CHECKSUM_BYTES) {
    throw new RecoveryKitCodecError("recovery_kit_truncated", "Recovery kit code is too short.")
  }
  const payload = bytes.subarray(0, bytes.length - CHECKSUM_BYTES)
  const expectedChecksum = bytes.subarray(bytes.length - CHECKSUM_BYTES)
  if (!checksum(payload).equals(expectedChecksum)) {
    throw new RecoveryKitCodecError("recovery_kit_checksum_mismatch", "Recovery kit code failed its checksum.")
  }
  if (payload[0] !== RECOVERY_KIT_VERSION) {
    throw new RecoveryKitCodecError("recovery_kit_version_unsupported", "Recovery kit code uses an unsupported version.")
  }
  const db = readLengthPrefixed(payload, 1, "Database encryption key")
  const credential = readLengthPrefixed(payload, db.offset, "Credential encryption key")
  if (credential.offset !== payload.length) {
    throw new RecoveryKitCodecError("recovery_kit_trailing_data", "Recovery kit code contains trailing data.")
  }
  if (credential.bytes.length === 0) {
    throw new RecoveryKitCodecError("recovery_kit_key_required", "Credential encryption key is required.")
  }
  return {
    credentialEncryptionKey: decodeUtf8(credential.bytes, "Credential encryption key"),
    databaseEncryptionKey: db.bytes.length === 0 ? null : decodeUtf8(db.bytes, "Database encryption key"),
  }
}
