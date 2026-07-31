import { createHash } from "node:crypto"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "node:test"
import {
  loadInstalledGithubManifest,
  loadInstalledManifest,
} from "./installed-manifest.js"

const tempRoots = []

function hash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "dataconnect-pdpp-manifest-"))
  tempRoots.push(root)
  mkdirSync(join(root, "profile"))
  mkdirSync(join(root, "dist"))
  const manifest = {
    protocol_version: "0.1.0",
    connector_id: "https://registry.pdpp.org/connectors/github",
    connector_key: "github",
    version: "0.5.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [{ name: "user" }],
    ...overrides.manifest,
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const entrypointBytes = Buffer.from("export default {};")
  const provenanceBytes = Buffer.from(
    JSON.stringify({ source: "fixture", version: "0.5.0" })
  )
  writeFileSync(join(root, "profile/collection-profile.json"), manifestBytes)
  writeFileSync(join(root, "dist/collection-profile.mjs"), entrypointBytes)
  writeFileSync(join(root, "provenance.json"), provenanceBytes)
  const install = {
    connectorId: "github-pdpp",
    version: "0.5.0",
    rootPath: root,
    artifactKind: "pdpp-collection-profile",
    manifestPath: "profile/collection-profile.json",
    entrypointPath: "dist/collection-profile.mjs",
    provenancePath: "provenance.json",
    manifestSha256: hash(manifestBytes),
    entrypointSha256: hash(entrypointBytes),
    provenanceSha256: hash(provenanceBytes),
    ...overrides.install,
  }
  const activePath = join(root, "connectors-active.json")
  writeFileSync(
    activePath,
    JSON.stringify({ connectors: { "github-pdpp": install } })
  )
  return { activePath, root }
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(
    tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))
  )
})

describe("loadInstalledGithubManifest", () => {
  it("returns the actual validated manifest with provenance and version", () => {
    const { activePath } = fixture()
    const loaded = loadInstalledGithubManifest({
      activeManifestPath: activePath,
    })
    assert.equal(loaded.version, "0.5.0")
    assert.equal(loaded.manifestDigest.startsWith("sha256:"), true)
    assert.equal(loaded.manifest.connector_key, "github")
    assert.equal(loaded.manifest.streams[0].name, "user")
    assert.deepEqual(loaded.provenance, { source: "fixture", version: "0.5.0" })
  })

  for (const [label, overrides] of [
    ["manifest version", { manifest: { version: "0.6.0" } }],
    [
      "manifest canonical connector id",
      { manifest: { connector_id: "github-pdpp" } },
    ],
    ["manifest connector key", { manifest: { connector_key: "not-github" } }],
    ["manifest digest", { install: { manifestSha256: "sha256:bad" } }],
    ["provenance digest", { install: { provenanceSha256: "sha256:bad" } }],
  ]) {
    it(`fails closed on ${label} mismatch`, () => {
      const { activePath } = fixture(overrides)
      assert.throws(
        () => loadInstalledGithubManifest({ activeManifestPath: activePath }),
        /Invalid installed PDPP GitHub connector/
      )
    })
  }
})

it("loads a selected browser-bound ChatGPT profile after all artifact hashes verify", () => {
  const { activePath } = fixture({
    manifest: {
      connector_id: "https://registry.pdpp.org/connectors/chatgpt",
      connector_key: "chatgpt",
      runtime_requirements: {
        bindings: { network: { required: true }, browser: { required: true } },
      },
    },
    install: { connectorId: "chatgpt-pdpp" },
  })
  const active = JSON.parse(readFileSync(activePath, "utf8"))
  active.connectors["chatgpt-pdpp"] = active.connectors["github-pdpp"]
  delete active.connectors["github-pdpp"]
  writeFileSync(activePath, JSON.stringify(active))

  const loaded = loadInstalledManifest({
    activeManifestPath: activePath,
    connectorId: "chatgpt-pdpp",
    expectedConnector: {
      key: "chatgpt",
      id: "https://registry.pdpp.org/connectors/chatgpt",
    },
  })
  assert.equal(loaded.manifest.connector_key, "chatgpt")
})
