// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import {
  CursorExpiredError,
  GrantScopedRecordsRepository,
  RecordsRepositoryError,
  createStreamMetadata,
} from "./grant-scoped-records-repository.js"
import { importLatestSnapshot } from "./github-snapshot.js"
import { resolveSelectedInstalledManifest } from "./installed-manifest.js"
import { createCoreApp } from "./index.js"
import { CoreOperationError } from "./operations.js"
import { createHttpTokenIntrospector } from "./token-introspector.js"

const DEFAULT_CONNECTION_ID = "default"

/**
 * Compose the validated selected profile, durable record store, and
 * opaque-token boundary into the transport-independent Core route surface.
 */
export async function createPdppResourceServer({
  activeManifestPath,
  connectorId = "github-pdpp",
  expectedConnector,
  selectedInstall,
  databasePath,
  exportRoot,
  connectionId = DEFAULT_CONNECTION_ID,
  recordsRepository,
  requestId,
  tokenIntrospector = createHttpTokenIntrospector({
    url: process.env.PDPP_TOKEN_INTROSPECTION_URL,
    authorization: process.env.PDPP_INTROSPECTION_AUTHORIZATION,
  }),
} = {}) {
  const installed = resolveSelectedInstalledManifest({
    activeManifestPath,
    connectorId,
    expectedConnector,
    selectedInstall,
  })
  const streamMetadata = createStreamMetadata(installed.manifest)
  const repository =
    recordsRepository ?? createRepository(databasePath, streamMetadata)
  const refreshSnapshot = createSnapshotRefresher({
    exportRoot,
    manifest: installed.manifest,
    manifestDigest: installed.manifestDigest,
    repository,
    connectionId,
  })
  await refreshSnapshot()
  return createCoreApp({
    manifest: installed.manifest,
    requestId,
    tokenIntrospector: createGrantValidatedIntrospector(
      tokenIntrospector,
      installed
    ),
    recordsRepository: createCoreRepositoryPort({
      repository,
      connectionId,
      refreshSnapshot,
    }),
  })
}

/** Add PDPP reads without taking ownership of legacy Personal Server routes. */
export async function mountPdppResourceServer(app, options) {
  const resourceServer = await createPdppResourceServer(options)
  mountPdppResourceRoutes(app, resourceServer)
  return resourceServer
}

export function mountPdppResourceRoutes(app, resourceServer) {
  const serve = context => resourceServer.fetch(context.req.raw)
  app.get("/v1/streams", serve)
  app.get("/v1/streams/:stream/records", serve)
  app.get("/v1/streams/:stream/records/:recordId", serve)
}

function createRepository(databasePath, streamMetadata) {
  if (typeof databasePath !== "string" || databasePath.length === 0) {
    throw new TypeError(
      "createPdppResourceServer requires databasePath or recordsRepository"
    )
  }
  mkdirSync(dirname(databasePath), { recursive: true })
  return new GrantScopedRecordsRepository({ databasePath, streamMetadata })
}

function createGrantValidatedIntrospector(tokenIntrospector, installed) {
  if (typeof tokenIntrospector?.introspect !== "function") {
    throw new TypeError("tokenIntrospector.introspect must be a function")
  }
  return {
    async introspect(token) {
      const identity = await tokenIntrospector.introspect(token)
      if (identity?.active !== true) {
        const reason = identity?.inactive_reason ?? identity?.reason
        if (reason === "grant_revoked" || reason === "revoked") {
          throw new CoreOperationError(
            403,
            "grant_revoked",
            "The grant has been revoked"
          )
        }
        if (reason === "grant_expired" || reason === "expired") {
          throw new CoreOperationError(
            403,
            "grant_expired",
            "The grant has expired"
          )
        }
        return identity
      }
      if (!Array.isArray(identity?.grant?.streams)) {
        throw new CoreOperationError(
          403,
          "grant_invalid",
          "The token does not contain a usable grant"
        )
      }
      if (
        identity.grant.source?.kind !== "connector" ||
        ![
          installed.manifest.connector_id,
          installed.manifest.connector_key,
        ].includes(identity.grant.source?.id) ||
        identity.grant.manifest_version !== installed.version ||
        identity.grant.manifest_digest !== installed.manifestDigest
      ) {
        throw new CoreOperationError(
          403,
          "grant_invalid",
          "The grant is not bound to the selected installed manifest"
        )
      }
      return identity
    },
  }
}

export function createSnapshotRefresher(dependencies) {
  let inFlight = null
  const snapshotCache = {
    files: new Map(),
    directories: new Map(),
    importedGeneration: null,
    importedPath: null,
    rejectedGenerations: new Set(),
  }
  return async () => {
    if (inFlight !== null) return inFlight
    inFlight = importLatestSnapshot({
      ...dependencies,
      snapshotCache,
    }).finally(() => {
      inFlight = null
    })
    return inFlight
  }
}

function createCoreRepositoryPort({
  repository,
  connectionId,
  refreshSnapshot,
}) {
  for (const method of [
    "summarizeCurrent",
    "listCurrent",
    "listChanges",
    "getCurrent",
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`recordsRepository.${method} must be a function`)
    }
  }
  return {
    async listStreams({ grant, manifest }) {
      await refreshSnapshot()
      return translateRepositoryErrors(() =>
        (grant.streams ?? []).flatMap(grantStream => {
          if (
            !manifest.streams.some(stream => stream.name === grantStream.name)
          )
            return []
          const summary = repository.summarizeCurrent({
            connectionId,
            stream: grantStream.name,
            grant: grantStream,
          })
          return [{ object: "stream", name: grantStream.name, ...summary }]
        })
      )
    },
    async listRecords({
      stream,
      grant,
      cursor,
      order,
      limit,
      fields,
      filters,
      changesSince,
    }) {
      await refreshSnapshot()
      return translateRepositoryErrors(() => {
        if (changesSince !== null) {
          return repository.listChanges({
            connectionId,
            stream,
            grant,
            cursor,
            limit,
            changesSince,
          })
        }
        return repository.listCurrent({
          connectionId,
          stream,
          grant,
          cursor,
          limit,
          order,
          fields,
          filter: filters,
        })
      })
    },
    async getRecord({ stream, recordId, grant }) {
      await refreshSnapshot()
      return translateRepositoryErrors(() =>
        repository.getCurrent({
          connectionId,
          stream,
          key: recordId,
          grant,
        })
      )
    },
  }
}

async function translateRepositoryErrors(operation) {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof CursorExpiredError) {
      throw new CoreOperationError(410, error.code, error.message)
    }
    if (error instanceof RecordsRepositoryError) {
      const status =
        error.code === "field_not_granted" || error.code === "grant_invalid"
          ? 403
          : 400
      throw new CoreOperationError(status, error.code, error.message)
    }
    throw error
  }
}
