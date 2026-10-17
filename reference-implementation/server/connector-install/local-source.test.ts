// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import {
  createFileLocalConnectorSourceStore,
  inspectActiveLocalConnectorSource,
} from "./local-source.ts"

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
    () => store.add(fixture({ key: "bad-binding", binding: "usb" })),
    /unsupported runtime binding/
  )
})
