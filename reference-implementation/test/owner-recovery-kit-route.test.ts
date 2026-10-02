// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"

import { decodeRecoveryKitV2 } from "../server/recovery-kit-codec.ts"
import {
  createServerRecoveryKitExporter,
  mountOwnerRecoveryKit,
  type ServerRecoveryKitExporter,
} from "../server/routes/owner-recovery-kit.ts"
import {
  CREDENTIAL_ENCRYPTION_KEY_ENV,
  CREDENTIAL_ENCRYPTION_KEY_FILE_ENV,
} from "../server/stores/credential-encryption.ts"
import { DATABASE_ENCRYPTION_KEY_ENV } from "../server/sqlite-encryption.ts"

interface CapturedResponse {
  body: unknown
  status: number
}

type Handler = (req: unknown, res: unknown) => unknown | Promise<unknown>
type Middleware = (req: unknown, res: unknown, next: () => void) => unknown | Promise<unknown>
type RegisteredArg = Handler | Middleware

class FakeApp {
  readonly routes = new Map<string, Handler>()
  readonly registrations = new Map<string, RegisteredArg[]>()

  post(path: string, ...args: unknown[]): this {
    const key = `POST ${path}`
    this.registrations.set(key, args as RegisteredArg[])
    this.routes.set(key, args.at(-1) as Handler)
    return this
  }
}

function makeRes(): { captured: CapturedResponse; res: unknown } {
  const captured: CapturedResponse = { body: undefined, status: 200 }
  const res = {
    json: (body: unknown) => {
      captured.body = body
      return res
    },
    status: (code: number) => {
      captured.status = code
      return res
    },
  }
  return { captured, res }
}

function mount(exporter: ServerRecoveryKitExporter): FakeApp["routes"] {
  const app = new FakeApp()
  mountOwnerRecoveryKit(app as unknown as Parameters<typeof mountOwnerRecoveryKit>[0], {
    exporter,
    handleError: (res, err) => {
      ;(res as { status: (code: number) => { json: (body: unknown) => void } })
        .status(500)
        .json({ error: { message: err instanceof Error ? err.message : String(err) } })
    },
    requireOwner: (...args: unknown[]) => (args[2] as () => void)(),
    requireToken: (...args: unknown[]) => (args[2] as () => void)(),
  })
  return app.routes
}

test("server recovery-kit exporter includes credential and configured SQLite database keys", () => {
  const exporter = createServerRecoveryKitExporter({
    env: {
      [CREDENTIAL_ENCRYPTION_KEY_ENV]: "credential-vault-key",
      [DATABASE_ENCRYPTION_KEY_ENV]: "sqlite-db-key",
    },
    getStorageBackend: () => "sqlite",
  })

  assert.deepEqual(decodeRecoveryKitV2(exporter.exportCode()), {
    credentialEncryptionKey: "credential-vault-key",
    databaseEncryptionKey: "sqlite-db-key",
  })
})

test("server recovery-kit exporter omits the database key for Postgres", () => {
  const exporter = createServerRecoveryKitExporter({
    env: {
      [CREDENTIAL_ENCRYPTION_KEY_ENV]: "credential-vault-key",
      [DATABASE_ENCRYPTION_KEY_ENV]: "sqlite-db-key",
    },
    getStorageBackend: () => "postgres",
  })

  assert.deepEqual(decodeRecoveryKitV2(exporter.exportCode()), {
    credentialEncryptionKey: "credential-vault-key",
    databaseEncryptionKey: null,
  })
})

test("server recovery-kit exporter omits the database key for SQLite when it is unconfigured", () => {
  const exporter = createServerRecoveryKitExporter({
    env: {
      [CREDENTIAL_ENCRYPTION_KEY_ENV]: "credential-vault-key",
    },
    getStorageBackend: () => "sqlite",
  })

  assert.deepEqual(decodeRecoveryKitV2(exporter.exportCode()), {
    credentialEncryptionKey: "credential-vault-key",
    databaseEncryptionKey: null,
  })
})

test("POST recovery-kit export returns a display-ready code", async () => {
  const routes = mount({ exportCode: () => "0200-0000-036B-6579-E5EA" })
  const handler = routes.get("POST /v1/owner/recovery-kit/export")
  assert.ok(handler)

  const { captured, res } = makeRes()
  await handler?.({}, res)
  assert.deepEqual(captured.body, { data: { code: "0200-0000-036B-6579-E5EA" }, object: "recovery_kit_export" })
})

test("POST recovery-kit export is guarded by owner token and owner session middleware", () => {
  const app = new FakeApp()
  mountOwnerRecoveryKit(app as unknown as Parameters<typeof mountOwnerRecoveryKit>[0], {
    exporter: { exportCode: () => "CODE" },
    handleError: () => {},
    requireOwner: () => {},
    requireToken: () => {},
  })
  assert.equal(
    app.registrations.get("POST /v1/owner/recovery-kit/export")?.length,
    3,
    "expected requireToken, requireOwner, and the handler"
  )
})

test("POST recovery-kit export denial stops before the exporter runs", async () => {
  let exported = false
  const app = new FakeApp()
  mountOwnerRecoveryKit(app as unknown as Parameters<typeof mountOwnerRecoveryKit>[0], {
    exporter: {
      exportCode: () => {
        exported = true
        return "CODE"
      },
    },
    handleError: () => {},
    requireOwner: (...args: unknown[]) => (args[2] as () => void)(),
    requireToken: (_req: unknown, res: unknown) => {
      ;(res as { status: (code: number) => { json: (body: unknown) => void } })
        .status(401)
        .json({ error: { code: "missing_token" } })
    },
  })
  const registration = app.registrations.get("POST /v1/owner/recovery-kit/export")
  assert.ok(registration)

  const { captured, res } = makeRes()
  let index = 0
  const next = async (): Promise<void> => {
    const step = registration[index++]
    if (typeof step === "function") {
      await step({}, res, next)
    }
  }
  await next()

  assert.equal(captured.status, 401)
  assert.deepEqual(captured.body, { error: { code: "missing_token" } })
  assert.equal(exported, false)
})

test("POST recovery-kit export surfaces missing credential-key configuration as an error", async () => {
  const routes = mount(
    createServerRecoveryKitExporter({
      env: {},
      getStorageBackend: () => "sqlite",
    })
  )
  const handler = routes.get("POST /v1/owner/recovery-kit/export")

  const { captured, res } = makeRes()
  await handler?.({}, res)
  assert.equal(captured.status, 500)
  assert.match(String((captured.body as { error: { message: string } }).error.message), /Credential encryption key/)
})

test("POST recovery-kit export surfaces key-file read errors without echoing secret env values", async () => {
  const secretEnvValue = "credential-vault-key-should-not-appear"
  const routes = mount(
    createServerRecoveryKitExporter({
      env: {
        [CREDENTIAL_ENCRYPTION_KEY_ENV]: "",
        [CREDENTIAL_ENCRYPTION_KEY_FILE_ENV]: "/definitely/missing/credential-key-file",
        SECRET_SENTINEL: secretEnvValue,
      },
      getStorageBackend: () => "sqlite",
    })
  )
  const handler = routes.get("POST /v1/owner/recovery-kit/export")

  const { captured, res } = makeRes()
  await handler?.({}, res)
  const message = String((captured.body as { error: { message: string } }).error.message)
  assert.equal(captured.status, 500)
  assert.match(message, /Credential encryption key file/)
  assert.doesNotMatch(message, new RegExp(secretEnvValue, "u"))
})
