// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  symlinkSync,
} from "node:fs"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import {
  createFileLocalConnectorSourceStore,
  inspectActiveLocalConnectorSource,
  readConfinedFile,
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
    readonly kind?: string
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
        ? { bindings: { [options.binding]: { required: true, ...(options.kind ? { kind: options.kind } : {}) } } }
        : { bindings: { network: { required: true } } },
      streams: [{ name: "items", primary_key: ["id"], schema: { type: "object", properties: { id: { type: "string" } } } }],
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
    streams: [{ name: "items", primary_key: ["id"], schema: { type: "object", properties: { id: { type: "string" } } } }],
    version: "1.2.3",
  }
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8")
  writeFileSync(join(root, "profile", "collection-profile.json"), bytes)

  const record = await createFileLocalConnectorSourceStore(dataDir).add(root)
  assert.equal(record.connectorId, manifest.connector_id)
  assert.equal(record.displayName, manifest.display_name)
  assert.equal(record.version, manifest.version)
  assert.deepEqual(record.manifest, manifest)
  assert.equal(record.manifestSha256, "sha256:" + createHash("sha256").update(bytes).digest("hex"))
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

test("local admission rejects unsupported runtime bindings", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const store = createFileLocalConnectorSourceStore(dataDir)
  await assert.rejects(
    () => store.add(fixture({ key: "bad-binding", binding: "usb", kind: "usb" })),
    /runtime_requirements.bindings.usb.kind must be equal to one of the allowed values/
  )
})

test("a selection pointing at a record for another connector key selects nothing", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const store = createFileLocalConnectorSourceStore(dataDir)
  const source = await store.add(fixture({ key: "first-fixture" }))
  await store.select("first-fixture", source.sourceId)
  // An earlier add() replaced the record without an identity check, so a state
  // file can keep the first key's selection on a record for another key.
  const statePath = join(dataDir, "connector-local-sources.json")
  const state = JSON.parse(readFileSync(statePath, "utf8"))
  state.sources[source.sourceId] = {
    ...state.sources[source.sourceId],
    connectorId: "https://registry.pdpp.dev/connectors/second-fixture",
    connectorKey: "second-fixture",
  }
  writeFileSync(statePath, JSON.stringify(state))
  assert.equal(await store.getSelectedForConnector("first-fixture"), null)
  assert.equal(
    await store.getSelectedForConnector(source.connectorId),
    null
  )
})

test("re-adding a source whose profile changed connector key is rejected", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const root = fixture({ key: "first-fixture" })
  const store = createFileLocalConnectorSourceStore(dataDir)
  const source = await store.add(root)
  const changed = fixture({ key: "second-fixture" })
  writeFileSync(
    join(root, "profile", "collection-profile.json"),
    readFileSync(join(changed, "profile", "collection-profile.json"))
  )
  await assert.rejects(store.add(root), /changed connector identity/)
  assert.equal((await store.list()).find((item) => item.sourceId === source.sourceId)?.connectorKey, "first-fixture")
})

test("a confined read refuses a file replaced after its check and stops one byte past the limit", () => {
  const root = fixture()
  const path = join(root, "profile", "collection-profile.json")
  const checked = { label: "Manifest", path, stat: lstatSync(path) }
  writeFileSync(join(root, "replacement.json"), "{}")
  renameSync(join(root, "replacement.json"), path)
  assert.throws(
    () => readConfinedFile(checked, 1024),
    /Manifest changed while it was being read/
  )

  const current = { label: "Manifest", path, stat: lstatSync(path) }
  writeFileSync(path, "x".repeat(100))
  assert.equal(readConfinedFile(current, 10).byteLength, 11)
  assert.equal(readConfinedFile(current, 1000).byteLength, 100)
})

test("a confined read refuses a parent directory swapped for a link outside the root after its check", () => {
  const root = fixture()
  const outside = fixture({ key: "outside-fixture" })
  const path = join(root, "profile", "collection-profile.json")
  const checked = { label: "Manifest", path, stat: lstatSync(path) }
  renameSync(join(root, "profile"), join(root, "profile-checked"))
  symlinkSync(join(outside, "profile"), join(root, "profile"))
  assert.throws(
    () => readConfinedFile(checked, 1024),
    /Manifest changed while it was being read/
  )
})
