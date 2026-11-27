// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { initDb } from "../reference-implementation/server/db.ts"
import { canonicalConnectorKey } from "../reference-implementation/server/connector-key.ts"
import {
  admitOwnerRunConnection,
  createSqliteConnectorInstanceStore,
} from "../reference-implementation/server/stores/connector-instance-store.ts"
import { runConnector } from "../reference-implementation/runtime/index.ts"

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const name = process.argv[2]
if (name !== "spotify" && name !== "github" && name !== "reddit") {
  throw new Error(`Unsupported fixture connector: ${name ?? "(missing)"}`)
}

const {
  PDPP_AS_URL: asUrl,
  PDPP_RS_URL: rsUrl,
  PDPP_DB_PATH: dbPath,
  PDPP_OWNER_TOKEN: ownerToken,
} = process.env
if (!asUrl || !rsUrl || !dbPath || !ownerToken) {
  throw new Error("Seed requires harness AS, RS, DB, and owner-token values")
}

initDb(dbPath)
const manifestPath = join(
  repo,
  "reference-implementation/fixtures/seed-manifests",
  `${name}.json`
)
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
const registration = await fetch(`${asUrl}/connectors`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(manifest),
})
const registrationBody = await registration.text()
if (![200, 201, 409].includes(registration.status)) {
  throw new Error(
    `Connector registration failed (${registration.status}): ${registrationBody}`
  )
}

const connectorInstanceStore = createSqliteConnectorInstanceStore()
const result = await runConnector({
  admitRunConnection: async ({
    connectorId,
    connectorInstanceId,
    ownerSubjectId,
  }) => {
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore,
      ownerSubjectId: ownerSubjectId ?? "owner_local",
    })
    return {
      connectorId: namespace.connectorId,
      connectorInstanceId: namespace.connectorInstanceId,
      ownerSubjectId: namespace.ownerSubjectId,
    }
  },
  collectionMode: "full_refresh",
  connectorId:
    canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id,
  connectorPath: join(
    repo,
    "reference-implementation/connectors/seed/index.ts"
  ),
  manifest,
  ownerToken,
  rsUrl,
  state: null,
})
if (result.status !== "succeeded" || (result.records_emitted ?? 0) < 1) {
  throw new Error(
    `Seed run did not produce records: status=${result.status}, emitted=${result.records_emitted ?? 0}, error=${result.connector_error?.message ?? "none"}, reason=${result.terminal_reason ?? "none"}`
  )
}
console.log(`Seeded ${name}: ${result.records_emitted} records`)
