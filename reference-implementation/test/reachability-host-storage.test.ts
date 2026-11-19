// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadHostIdentity } from "../server/reachability/identity.ts"
import { createSealedFileSecretBackend } from "../server/reachability/sealed-file-secret-backend.ts"
import { createCredentialCipher } from "../server/stores/credential-encryption.ts"

const KEY = "backend-test-key-material-0123456789"
const cipher = createCredentialCipher(KEY)
const scope = (scopeId: string, handle: string) => ({ handle, scopeId })
const secret = new TextEncoder().encode("token-canary-value")

function temp(): string {
  return mkdtempSync(join(tmpdir(), "reachability-host-storage-"))
}
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected

test("sealed backend: put, use, presence and delete round-trip without plaintext on disk", async () => {
  const dir = temp()
  try {
    const backend = createSealedFileSecretBackend(dir, () => cipher)
    const { handle } = await backend.put({ bytes: secret, inputId: "token", revision: "r1", scopeId: "scope-a" })
    assert.deepEqual(await backend.presence(scope("scope-a", handle)), { known: true, value: true })
    const used = await backend.withSecret(scope("scope-a", handle), async (bytes) => new TextDecoder().decode(bytes))
    assert.equal(used, "token-canary-value")
    const [file] = readdirSync(dir)
    assert.ok(file)
    assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600)
    assert.ok(!readFileSync(join(dir, file), "utf8").includes("token-canary-value"))
    assert.deepEqual(await backend.delete(scope("scope-a", handle)), { deleted: true })
    assert.deepEqual(await backend.delete(scope("scope-a", handle)), { deleted: false })
    assert.deepEqual(await backend.presence(scope("scope-a", handle)), { known: true, value: false })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("sealed backend: a locked key makes presence unknown, never absent, and refuses use and delete", async () => {
  const dir = temp()
  try {
    let key: ReturnType<typeof createCredentialCipher> | null = cipher
    const backend = createSealedFileSecretBackend(dir, () => key)
    const { handle } = await backend.put({ bytes: secret, inputId: "token", revision: "r1", scopeId: "scope-a" })
    key = null
    assert.deepEqual(await backend.presence(scope("scope-a", handle)), {
      known: false,
      reason: "secret_backend_locked",
    })
    await assert.rejects(backend.withSecret(scope("scope-a", handle), async () => 0), code("secret_backend_locked"))
    await assert.rejects(backend.delete(scope("scope-a", handle)), code("secret_backend_locked"))
    await assert.rejects(
      backend.put({ bytes: secret, inputId: "token", revision: "r2", scopeId: "scope-a" }),
      code("secret_backend_locked")
    )
    // A different key cannot open the file either; that is also unknown, not absent.
    key = createCredentialCipher("some-other-key-material-0123456789")
    assert.equal((await backend.presence(scope("scope-a", handle))).known, false)
    // The key returning unlocks it again with no restart.
    key = cipher
    assert.deepEqual(await backend.presence(scope("scope-a", handle)), { known: true, value: true })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("sealed backend: a wrong key is its own fault, not a lock, and the right key still opens the file", async () => {
  const dir = temp()
  try {
    let key: ReturnType<typeof createCredentialCipher> | null = cipher
    const backend = createSealedFileSecretBackend(dir, () => key)
    const { handle } = await backend.put({ bytes: secret, inputId: "token", revision: "r1", scopeId: "scope-a" })
    key = createCredentialCipher("some-other-key-material-0123456789")
    assert.deepEqual(await backend.presence(scope("scope-a", handle)), {
      known: false,
      reason: "secret_key_mismatch",
    })
    await assert.rejects(backend.withSecret(scope("scope-a", handle), async () => 0), code("secret_key_mismatch"))
    await assert.rejects(backend.delete(scope("scope-a", handle)), code("secret_key_mismatch"))
    // A lock clears when the key returns; this clears only when the right key does.
    key = null
    assert.deepEqual(await backend.presence(scope("scope-a", handle)), { known: false, reason: "secret_backend_locked" })
    key = cipher
    assert.deepEqual(await backend.presence(scope("scope-a", handle)), { known: true, value: true })
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("sealed backend: polling presence opens a file once per key, not once per call", async () => {
  const dir = temp()
  try {
    let opens = 0
    const counting = {
      ...cipher,
      open: (sealed: string) => {
        opens++
        return cipher.open(sealed)
      },
    }
    const backend = createSealedFileSecretBackend(dir, () => counting)
    const { handle } = await backend.put({ bytes: secret, inputId: "token", revision: "r1", scopeId: "scope-a" })
    for (let call = 0; call < 10; call++) {
      assert.deepEqual(await backend.presence(scope("scope-a", handle)), { known: true, value: true })
    }
    assert.equal(opens, 1)
    // A replaced file is read again.
    const { handle: other } = await backend.put({ bytes: secret, inputId: "token", revision: "r2", scopeId: "scope-a" })
    await backend.presence(scope("scope-a", other))
    assert.equal(opens, 2)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("sealed backend: the presence cache keeps one entry per handle, so it stays bounded", async () => {
  const dir = temp()
  try {
    let opens = 0
    const counting = {
      ...cipher,
      open: (sealed: string) => {
        opens++
        return cipher.open(sealed)
      },
    }
    const backend = createSealedFileSecretBackend(dir, () => counting)
    const { handle } = await backend.put({ bytes: secret, inputId: "token", revision: "r1", scopeId: "scope-a" })
    const { handle: other } = await backend.put({ bytes: secret, inputId: "token", revision: "r2", scopeId: "scope-a" })
    const first = readFileSync(join(dir, `${handle}.sealed`))
    await backend.presence(scope("scope-a", handle))
    // Replace the file under the same handle, then put the first content back:
    // each content the handle held replaces the entry before it.
    copyFileSync(join(dir, `${other}.sealed`), join(dir, `${handle}.sealed`))
    await backend.presence(scope("scope-a", handle))
    writeFileSync(join(dir, `${handle}.sealed`), first)
    await backend.presence(scope("scope-a", handle))
    assert.equal(opens, 3)
    // A deleted handle leaves no entry: the same content written again is opened again.
    await backend.delete(scope("scope-a", handle))
    const opensBefore = opens
    writeFileSync(join(dir, `${handle}.sealed`), first)
    await backend.presence(scope("scope-a", handle))
    assert.equal(opens, opensBefore + 1)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("sealed backend: a file moved across scopes or onto a foreign name is refused", async () => {
  const dir = temp()
  try {
    const backend = createSealedFileSecretBackend(dir, () => cipher)
    const { handle } = await backend.put({ bytes: secret, inputId: "token", revision: "r1", scopeId: "scope-a" })
    await assert.rejects(backend.withSecret(scope("scope-b", handle), async () => 0), code("secret_scope_mismatch"))
    assert.deepEqual(await backend.presence(scope("scope-b", handle)), { known: true, value: false })
    await assert.rejects(backend.delete(scope("scope-b", handle)), code("secret_scope_mismatch"))
    // Copy the sealed file under a second handle: the payload still names scope-a.
    const copied = "00000000-0000-4000-8000-000000000000"
    copyFileSync(join(dir, `${handle}.sealed`), join(dir, `${copied}.sealed`))
    await assert.rejects(backend.withSecret(scope("scope-b", copied), async () => 0), code("secret_scope_mismatch"))
    assert.equal(await backend.withSecret(scope("scope-a", copied), async (bytes) => bytes.length), secret.length)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("sealed backend: a handle that is not one it issued never reaches the filesystem", async () => {
  const dir = temp()
  try {
    const backend = createSealedFileSecretBackend(dir, () => cipher)
    for (const handle of ["../outside", "a/b", "", "not-a-uuid"]) {
      await assert.rejects(backend.withSecret(scope("scope-a", handle), async () => 0), code("secret_not_found"))
      assert.deepEqual(await backend.delete(scope("scope-a", handle)), { deleted: false })
      assert.deepEqual(await backend.presence(scope("scope-a", handle)), { known: true, value: false })
    }
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test("identity: the instance survives a restart and every start has a new boot", () => {
  const dir = temp()
  try {
    const first = loadHostIdentity(join(dir, "reachability"))
    const second = loadHostIdentity(join(dir, "reachability"))
    assert.equal(second.instanceId, first.instanceId)
    assert.notEqual(second.bootId, first.bootId)
    assert.equal(statSync(join(dir, "reachability", "instance-id")).mode & 0o777, 0o600)
    // A damaged file is not silently replaced by a new instance.
    writeFileSync(join(dir, "reachability", "instance-id"), "not-a-uuid\n")
    assert.throws(() => loadHostIdentity(join(dir, "reachability")), /instance_id_unreadable/)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
