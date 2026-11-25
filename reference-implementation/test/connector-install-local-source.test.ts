// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import {
  createFileLocalConnectorSourceStore,
  inspectActiveLocalConnectorSource,
} from "../server/connector-install/local-source.ts"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

function fixture(
  options: {
    readonly key?: string
    readonly version?: string
    readonly binding?: string
  } = {}
): string {
  const root = mkdtempSync(join(process.cwd(), "tmp-local-source-test-"))
  temporaryRoots.push(root)
  mkdirSync(join(root, "profile"))
  mkdirSync(join(root, "dist"))
  writeFileSync(
    join(root, "profile", "collection-profile.json"),
    JSON.stringify({
      connector_id: `https://registry.pdpp.dev/connectors/${options.key ?? "developer-fixture"}`,
      connector_key: options.key ?? "developer-fixture",
      display_name: "Developer fixture",
      runtime_requirements: options.binding
        ? { bindings: { [options.binding]: { required: true } } }
        : { bindings: { network: { required: true } } },
      streams: [{ name: "items" }],
      version: options.version ?? "0.1.0",
    })
  )
  writeFileSync(
    join(root, "dist", "collection-profile.mjs"),
    "export default {};\n"
  )
  return root
}

test("records parsed fields and the digest of the exact manifest bytes", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const root = fixture()
  const manifest = {
    connector_id: "https://registry.pdpp.dev/connectors/snapshot-fixture",
    connector_key: "snapshot-fixture",
    display_name: "Snapshot fixture",
    streams: [{ name: "items" }],
    version: "1.2.3",
  }
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8")
  writeFileSync(join(root, "profile", "collection-profile.json"), bytes)

  const record = await createFileLocalConnectorSourceStore(dataDir).add(root)
  assert.equal(record.connectorId, manifest.connector_id)
  assert.equal(record.displayName, manifest.display_name)
  assert.equal(record.version, manifest.version)
  assert.deepEqual(record.manifest, manifest)
  assert.equal(
    record.manifestSha256,
    "sha256:" + createHash("sha256").update(bytes).digest("hex")
  )
  assert.equal(record.trust, "developer-local-unsigned")
})

test("local sources coexist by key, select explicitly, and remain outside verified installs", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const firstPath = fixture()
  const secondPath = fixture()
  const store = createFileLocalConnectorSourceStore(dataDir)
  const first = await store.add(firstPath)
  const second = await store.add(secondPath)

  assert.equal((await store.list()).length, 2)
  assert.notEqual(first.sourceId, second.sourceId)
  assert.equal(existsSync(join(dataDir, "connector-install-state.json")), false)
  assert.equal(
    (await store.list()).filter(
      source => source.connectorKey === first.connectorKey
    ).length,
    2
  )

  await store.select(first.connectorKey, first.sourceId)
  const selected = await inspectActiveLocalConnectorSource(
    store,
    first.connectorId
  )
  assert.equal(selected.status, "active")
  if (selected.status === "active") {
    assert.equal(selected.record.trust, "developer-local-unsigned")
    assert.equal(selected.source.source_kind, "developer_local")
    assert.equal(selected.source.source_id, first.sourceId)
  }

  await store.remove(first.sourceId)
  assert.equal(
    (await inspectActiveLocalConnectorSource(store, first.connectorId)).status,
    "none"
  )
  assert.equal((await store.list()).length, 1)
})

test("reload refreshes hashes and drift blocks a selected local run until reload", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const sourcePath = fixture()
  const store = createFileLocalConnectorSourceStore(dataDir)
  const source = await store.add(sourcePath)
  await store.select(source.connectorKey, source.sourceId)
  writeFileSync(
    join(sourcePath, "dist", "collection-profile.mjs"),
    "export default { changed: true };\n"
  )

  const drifted = await inspectActiveLocalConnectorSource(
    store,
    source.connectorId
  )
  assert.equal(drifted.status, "invalid")
  const reloaded = await store.reload(source.sourceId)
  assert.notEqual(reloaded.entrypointSha256, source.entrypointSha256)
  const addedAgain = await store.add(sourcePath)
  assert.equal(addedAgain.sourceId, source.sourceId)
  assert.equal(addedAgain.selected, true)
  assert.equal(addedAgain.entrypointSha256, reloaded.entrypointSha256)
  assert.equal(
    (await store.getSelectedForConnector(source.connectorKey))?.sourceId,
    source.sourceId
  )
  assert.equal(
    (await inspectActiveLocalConnectorSource(store, source.connectorId)).status,
    "active"
  )
})

test("adding an existing root again refuses a changed connector identity", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const sourcePath = fixture()
  const store = createFileLocalConnectorSourceStore(dataDir)
  const source = await store.add(sourcePath)
  const manifestPath = join(sourcePath, "profile", "collection-profile.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, connector_key: `${source.connectorKey}-renamed` })
  )
  await assert.rejects(
    () => store.add(sourcePath),
    /changed connector identity/
  )
  assert.equal((await store.list())[0]?.connectorKey, source.connectorKey)
})

test("local admission rejects unsupported runtime bindings", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const store = createFileLocalConnectorSourceStore(dataDir)
  await assert.rejects(
    () => store.add(fixture({ key: "bad-binding", binding: "usb" })),
    /unsupported runtime binding/
  )
})
