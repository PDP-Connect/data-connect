// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "vitest"
import {
  certificateDER,
  inspectBinary,
  sha256,
  type Certificate,
  type Inventory,
} from "./browser-trust-oracle.ts"

function certificate(name: string, bytes: Buffer): Certificate {
  return {
    name,
    sha256: sha256(bytes),
    pem: `-----BEGIN CERTIFICATE-----\n${bytes.toString("base64")}\n-----END CERTIFICATE-----\n`,
    sourceURL: "https://example.invalid/synthetic-test-only",
  }
}
const controlBytes = Buffer.from([0x30, 2, 0x31, 1])
const holdBytes = Buffer.from([0x30, 2, 0x32, 1])
const inventory: Inventory = {
  positiveControl: certificate("synthetic control", controlBytes),
  holds: [
    {
      ...certificate("synthetic hold", holdBytes),
      reason: "fixture",
      reentry: "remove fixture after qualification",
    },
  ],
}
const binary = Buffer.concat([
  Buffer.from("prefix"),
  controlBytes,
  Buffer.from("middle"),
  holdBytes,
  Buffer.from("suffix"),
])

test("found DER returns a retained HOLD, not a trust verdict", () => {
  const result = inspectBinary(binary, inventory)
  assert.equal(result.ok, true)
  assert.equal(result.positiveControl.present, true)
  assert.deepEqual(result.holds, [
    {
      name: "synthetic hold",
      present: true,
      reentry: "remove fixture after qualification",
    },
  ])
})
test("not-found DER is reported", () => {
  const result = inspectBinary(Buffer.from("unrelated bytes"), inventory)
  assert.equal(result.holds[0].present, false)
  assert.equal(result.ok, false)
})
test("stale hold fails even with the positive control present", () => {
  const result = inspectBinary(controlBytes, inventory)
  assert.equal(result.positiveControl.present, true)
  assert.equal(result.holds[0].present, false)
  assert.equal(result.ok, false)
})
test("missing positive control fails even with hold present", () => {
  const result = inspectBinary(holdBytes, inventory)
  assert.equal(result.holds[0].present, true)
  assert.equal(result.positiveControl.present, false)
  assert.equal(result.ok, false)
})
test("sha256 mismatch in holds file fails before scanning", () => {
  const invalid = {
    ...inventory,
    holds: [{ ...inventory.holds[0], sha256: "0".repeat(64) }],
  }
  assert.throws(() => inspectBinary(binary, invalid), /sha256 mismatch/u)
})
test("positive control hash mismatch also fails", () => {
  assert.throws(
    () =>
      inspectBinary(binary, {
        ...inventory,
        positiveControl: {
          ...inventory.positiveControl,
          sha256: "0".repeat(64),
        },
      }),
    /sha256 mismatch/u
  )
})
test("malformed and empty PEM fail closed", () => {
  assert.throws(
    () => certificateDER({ ...inventory.positiveControl, pem: "not a PEM" }),
    /invalid PEM/u
  )
  assert.throws(
    () =>
      certificateDER({
        ...inventory.positiveControl,
        pem: "-----BEGIN CERTIFICATE-----\n\n-----END CERTIFICATE-----",
      }),
    /invalid (PEM|DER)/u
  )
})
test("checked-in primary-source PEM bytes match all recorded hashes", () => {
  const checkedIn = JSON.parse(
    readFileSync(new URL("./browser-trust-holds.json", import.meta.url), "utf8")
  ) as Inventory
  assert.equal(certificateDER(checkedIn.positiveControl).length, 1391)
  assert.equal(certificateDER(checkedIn.holds[0]).length, 594)
  assert.equal(
    inspectBinary(
      Buffer.concat([
        certificateDER(checkedIn.positiveControl),
        ...checkedIn.holds.map(certificateDER),
      ]),
      checkedIn
    ).ok,
    true
  )
})
