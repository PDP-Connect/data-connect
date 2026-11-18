// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { withFixtureSourceDeclaration } from "../../test/helpers/fixture-source-declaration.ts"
import {
  createFileLocalConnectorSourceStore,
  inspectActiveLocalConnectorSource,
} from "./local-source.ts"

const temporaryRoots: string[] = []
const RE_LOCAL_EXPAND_INVALID = /query\.expand.*same-stream relationships\[\] entry/
const RE_LOCAL_IDENTITY_MISMATCH = /connector_key must match the canonical key for connector_id/
const RE_MALFORMED_LOCAL_BINDING = /runtime_requirements\.bindings\.usb must have required property 'kind'/
const RE_MISSING_LOCAL_KEY = /connector_key/
const RE_DUPLICATE_LOCAL_JSON_KEY = /duplicate JSON object keys/
const RE_INVALID_ARTIFACT_URI = /connector_id must be an absolute URI or its declared connector_key/

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

function fixture(
  options: {
    readonly key?: string
    readonly connectorId?: string
    readonly version?: string
    readonly binding?: string
  } = {}
): string {
  const root = mkdtempSync(join(process.cwd(), "tmp-local-source-test-"))
  temporaryRoots.push(root)
  mkdirSync(join(root, "profile"))
  mkdirSync(join(root, "dist"))
  const manifest = JSON.parse(
    readFileSync(new URL("../../test/fixtures/collection-profiles/github.json", import.meta.url), "utf8")
  ) as Record<string, unknown>
  const connectorKey = options.key ?? "developer-fixture"
  manifest.connector_id = options.connectorId ?? `https://vendor.example/connectors/${connectorKey}`
  manifest.manifest_uri = manifest.connector_id
  manifest.connector_key = connectorKey
  manifest.version = options.version ?? "0.1.0"
  if (options.binding) {
    manifest.runtime_requirements = { bindings: { [options.binding]: { required: true } } }
  }
  writeFileSync(join(root, "profile", "collection-profile.json"), JSON.stringify(manifest))
  writeFileSync(
    join(root, "dist", "collection-profile.mjs"),
    "export default {};\n"
  )
  return root
}

function invalidateFirstExpand(root: string): void {
  const path = join(root, "profile", "collection-profile.json")
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  const streams = manifest.streams as Record<string, unknown>[]
  const [firstStream] = streams
  assert.ok(firstStream)
  firstStream.query = { expand: [{ name: "missing_relationship" }] }
  writeFileSync(path, JSON.stringify(manifest))
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

test("unknown URL artifacts require an explicit key and preserve original manifest bytes", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const sourcePath = fixture({ key: "custom-provider" })
  const manifestPath = join(sourcePath, "profile", "collection-profile.json")
  const originalText = readFileSync(manifestPath, "utf8")
  const originalManifest = JSON.parse(originalText) as Record<string, unknown>
  originalManifest.source_declaration = withFixtureSourceDeclaration(originalManifest).source_declaration
  writeFileSync(manifestPath, JSON.stringify(originalManifest))
  const originalBytes = readFileSync(manifestPath)
  const store = createFileLocalConnectorSourceStore(dataDir)

  const record = await store.add(sourcePath)

  assert.equal(record.connectorId, "https://vendor.example/connectors/custom-provider")
  assert.equal(record.connectorKey, "custom-provider")
  assert.equal(record.manifest.manifest_uri, record.connectorId)
  assert.deepEqual(record.manifest, originalManifest)
  assert.deepEqual(record.manifest.source_declaration, originalManifest.source_declaration)
  assert.equal(record.manifestSha256, `sha256:${createHash("sha256").update(originalBytes).digest("hex")}`)
  assert.deepEqual(readFileSync(manifestPath), originalBytes)
})

test("local add rejects invalid profiles before publishing source state", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const invalidPath = fixture({ key: "invalid-expand" })
  const store = createFileLocalConnectorSourceStore(dataDir)
  const baseline = await store.list()

  invalidateFirstExpand(invalidPath)
  await assert.rejects(() => store.add(invalidPath), RE_LOCAL_EXPAND_INVALID)
  assert.deepEqual(await store.list(), baseline)
})

test("local reload rejects invalid profiles without changing published state", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const validPath = fixture()
  const store = createFileLocalConnectorSourceStore(dataDir)
  const existing = await store.add(validPath)
  const baseline = await store.list()

  invalidateFirstExpand(validPath)
  await assert.rejects(() => store.reload(existing.sourceId), RE_LOCAL_EXPAND_INVALID)
  assert.deepEqual(await store.list(), baseline)
})

test("local admission refuses a recognized URL and explicit key conflict", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const store = createFileLocalConnectorSourceStore(dataDir)
  await assert.rejects(
    () => store.add(fixture({ connectorId: "https://registry.pdpp.dev/connectors/github", key: "different-key" })),
    RE_LOCAL_IDENTITY_MISMATCH
  )
  assert.deepEqual(await store.list(), [])

  const missingKeyPath = fixture()
  const manifestPath = join(missingKeyPath, "profile", "collection-profile.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  const manifestWithoutKey = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "connector_key"))
  writeFileSync(manifestPath, JSON.stringify(manifestWithoutKey))
  await assert.rejects(() => store.add(missingKeyPath), RE_MISSING_LOCAL_KEY)
  assert.deepEqual(await store.list(), [])

  const duplicateKeyPath = fixture()
  const duplicateManifestPath = join(duplicateKeyPath, "profile", "collection-profile.json")
  const validText = readFileSync(duplicateManifestPath, "utf8")
  const duplicateText = validText.replace(
    '"connector_key":"developer-fixture"',
    '"connector_key":"developer-fixture","connector_key":"other-key"'
  )
  assert.notEqual(duplicateText, validText)
  writeFileSync(duplicateManifestPath, duplicateText)
  await assert.rejects(() => store.add(duplicateKeyPath), RE_DUPLICATE_LOCAL_JSON_KEY)
  assert.deepEqual(await store.list(), [])
})

test("local admission rejects a malformed URL before publishing source state", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const store = createFileLocalConnectorSourceStore(dataDir)
  await assert.rejects(
    () => store.add(fixture({ connectorId: "https://[invalid", key: "malformed-uri" })),
    RE_INVALID_ARTIFACT_URI
  )
  assert.deepEqual(await store.list(), [])
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

test("local admission rejects malformed runtime binding declarations", async () => {
  const dataDir = mkdtempSync(join(process.cwd(), "tmp-local-source-state-"))
  temporaryRoots.push(dataDir)
  const store = createFileLocalConnectorSourceStore(dataDir)
  await assert.rejects(
    () => store.add(fixture({ binding: "usb", key: "bad-binding" })),
    RE_MALFORMED_LOCAL_BINDING
  )
})
