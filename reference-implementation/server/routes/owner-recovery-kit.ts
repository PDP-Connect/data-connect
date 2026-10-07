// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { encodeRecoveryKitV2 } from "../recovery-kit-codec.ts"
import { getStorageBackendKind } from "../postgres-storage.ts"
import { resolveCredentialEncryptionKey } from "../stores/credential-encryption.ts"
import { resolveDatabaseEncryptionKey } from "../sqlite-encryption.ts"
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts"

interface RouteRequest {
  readonly body?: unknown
}

interface RouteResponse {
  json: (body: unknown) => unknown
  status: (code: number) => RouteResponse
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>

interface AppLike {
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike
}

export interface ServerRecoveryKitExporter {
  exportCode: () => string
}

export interface ServerRecoveryKitExporterOptions {
  env?: NodeJS.ProcessEnv
  getStorageBackend?: () => string
}

export function createServerRecoveryKitExporter({
  env = process.env,
  getStorageBackend = getStorageBackendKind,
}: ServerRecoveryKitExporterOptions = {}): ServerRecoveryKitExporter {
  return {
    exportCode() {
      const credentialEncryptionKey = resolveCredentialEncryptionKey(env)
      if (!credentialEncryptionKey) {
        throw new Error("Credential encryption key is not configured; no server recovery kit can be exported.")
      }
      const databaseEncryptionKey =
        getStorageBackend() === "sqlite" ? resolveDatabaseEncryptionKey(env.PDPP_DATABASE_ENCRYPTION_KEY) : null
      return encodeRecoveryKitV2({ credentialEncryptionKey, databaseEncryptionKey })
    },
  }
}

export interface MountOwnerRecoveryKitContext {
  exporter: ServerRecoveryKitExporter
  handleError: (res: unknown, err: unknown) => void
  requireOwner: MiddlewareHandler
  requireToken: MiddlewareHandler
}

export function mountOwnerRecoveryKit(app: AppLike, ctx: MountOwnerRecoveryKitContext): void {
  const guarded = [ctx.requireToken, ctx.requireOwner] as const

  app.post(
    "/v1/owner/recovery-kit/export",
    ...guarded,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        const code = ctx.exporter.exportCode()
        res.json({ data: { code }, object: "recovery_kit_export" })
      } catch (err) {
        ctx.handleError(res, err)
      }
    }
  )
}
