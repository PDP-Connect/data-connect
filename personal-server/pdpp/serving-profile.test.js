// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { Hono } from "hono"

import { registerOptionalPdppSurfaces } from "../index.js"
import {
  createPdppServingProfile,
  pdppServingScope,
  servingProfileSnapshot,
} from "./serving-profile.js"

const tempRoots = []

function installed(manifest) {
  return { manifest }
}

function manifest(connectorKey, connectorId, streams, setup) {
  return {
    connector_key: connectorKey,
    connector_id: connectorId,
    version: "1.0.0",
    streams: streams.map(name => ({ name })),
    setup,
  }
}

test("canonical GitHub and ChatGPT profile tables preserve org and dev scopes", () => {
  const snapshots = ["org", "dev"].map(domain =>
    [
      servingProfileSnapshot(
        createPdppServingProfile({
          connectorId: "github-pdpp",
          installed: installed(
            manifest(
              "github",
              `https://registry.pdpp.${domain}/connectors/github`,
              ["user", "repositories", "starred", "issues"]
            )
          ),
        })
      ),
      servingProfileSnapshot(
        createPdppServingProfile({
          connectorId: "chatgpt-pdpp",
          installed: installed(
            manifest(
              "chatgpt",
              `https://registry.pdpp.${domain}/connectors/chatgpt`,
              [
                "conversations",
                "messages",
                "memories",
                "custom_gpts",
                "custom_instructions",
                "shared_conversations",
                "account",
              ]
            )
          ),
        })
      ),
    ].map(profile => ({
      ...profile,
      connector: { ...profile.connector, id: "canonical" },
    }))
  )

  assert.deepEqual(snapshots[0], snapshots[1])
  assert.deepEqual(snapshots[0], [
    {
      connectorId: "github-pdpp",
      connector: {
        key: "github",
        id: "canonical",
      },
      streams: [
        { name: "user", scope: "github.profile" },
        { name: "repositories", scope: "github.repositories" },
        { name: "starred", scope: "github.starred" },
        { name: "issues", scope: "pdpp.github.issues" },
      ],
      enableLocalTimeline: true,
    },
    {
      connectorId: "chatgpt-pdpp",
      connector: {
        key: "chatgpt",
        id: "canonical",
      },
      streams: [
        { name: "conversations", scope: "chatgpt.conversations" },
        { name: "messages", scope: "chatgpt.messages" },
        { name: "memories", scope: "chatgpt.memories" },
        { name: "custom_gpts", scope: "chatgpt.custom_gpts" },
        {
          name: "custom_instructions",
          scope: "chatgpt.custom_instructions",
        },
        {
          name: "shared_conversations",
          scope: "chatgpt.shared_conversations",
        },
        { name: "account", scope: "pdpp.chatgpt.account" },
      ],
      enableLocalTimeline: false,
    },
  ])
})

test("generic and manual profiles use the host projection rule", () => {
  assert.equal(
    pdppServingScope({
      connectorKey: "whatsapp",
      connectorId: "https://registry.pdpp.dev/connectors/whatsapp",
      stream: "messages",
      manual: false,
    }),
    "pdpp.whatsapp.messages"
  )
  assert.equal(
    pdppServingScope({
      connectorKey: "whatsapp",
      connectorId: "https://registry.pdpp.dev/connectors/whatsapp",
      stream: "messages",
      manual: true,
    }),
    "pdpp.manual.whatsapp.messages"
  )
})

function hash(contents) {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`
}

function addInstall(active, connectorId, profileManifest) {
  const root = mkdtempSync(join(tmpdir(), "dataconnect-serving-profile-"))
  tempRoots.push(root)
  mkdirSync(join(root, "profile"))
  mkdirSync(join(root, "dist"))
  const manifestBytes = Buffer.from(JSON.stringify(profileManifest))
  const entrypointBytes = Buffer.from("export default {};\n")
  const provenanceBytes = Buffer.from(JSON.stringify({ source: "test" }))
  writeFileSync(join(root, "profile/collection-profile.json"), manifestBytes)
  writeFileSync(join(root, "dist/collection-profile.mjs"), entrypointBytes)
  writeFileSync(join(root, "provenance.json"), provenanceBytes)
  active[connectorId] = {
    connectorId,
    manifestConnectorId: profileManifest.connector_id,
    version: profileManifest.version,
    rootPath: root,
    artifactKind: "pdpp-collection-profile",
    manifestPath: "profile/collection-profile.json",
    entrypointPath: "dist/collection-profile.mjs",
    provenancePath: "provenance.json",
    manifestSha256: hash(manifestBytes),
    entrypointSha256: hash(entrypointBytes),
    provenanceSha256: hash(provenanceBytes),
  }
}

function testStream() {
  return {
    name: "records",
    primary_key: ["id"],
    cursor_field: "updated_at",
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        updated_at: { type: "string", format: "date-time" },
      },
    },
  }
}

function networkSetup(...env) {
  return {
    modality: "static_secret",
    credential_capture: {
      fields: env.map(name => ({
        name: name.toLowerCase(),
        required: true,
        secret: true,
        env: [name],
      })),
    },
  }
}

test("mounts all admitted bundled and OTA profiles while skipping one malformed install", async t => {
  const root = mkdtempSync(join(tmpdir(), "dataconnect-serving-routes-"))
  tempRoots.push(root)
  const active = {}
  const profiles = [
    [
      "github-pdpp",
      "github",
      "https://registry.pdpp.dev/connectors/github",
      { bindings: { network: { required: true } } },
      networkSetup("GITHUB_TOKEN"),
    ],
    [
      "chatgpt-pdpp",
      "chatgpt",
      "https://registry.pdpp.dev/connectors/chatgpt",
      {
        bindings: { network: { required: true }, browser: { required: true } },
      },
      networkSetup("CHATGPT_USERNAME", "CHATGPT_PASSWORD"),
    ],
    [
      "apple-health-pdpp",
      "apple-health",
      "https://registry.pdpp.dev/connectors/apple-health",
      { bindings: { filesystem: { required: true } } },
      {
        modality: "manual_or_upload",
        manual_or_upload: { import_dir_env_var: "APPLE_HEALTH_EXPORT_DIR" },
      },
    ],
    [
      "ynab-pdpp",
      "ynab",
      "https://registry.pdpp.dev/connectors/ynab",
      { bindings: { network: { required: true } } },
      networkSetup("YNAB_TOKEN"),
    ],
    [
      "https://registry.pdpp.dev/connectors/whatsapp",
      "whatsapp",
      "https://registry.pdpp.dev/connectors/whatsapp",
      { bindings: { network: { required: true } } },
      networkSetup("WHATSAPP_TOKEN"),
    ],
  ]
  for (const [
    connectorId,
    key,
    identity,
    runtimeRequirements,
    setup,
  ] of profiles) {
    addInstall(active, connectorId, {
      connector_key: key,
      connector_id: identity,
      version: "1.0.0",
      runtime_requirements: runtimeRequirements,
      setup,
      streams: [testStream()],
    })
  }
  addInstall(active, "malformed-pdpp", {
    connector_key: "malformed key",
    connector_id: "https://registry.pdpp.dev/connectors/malformed",
    version: "1.0.0",
    runtime_requirements: { bindings: { network: { required: true } } },
    setup: networkSetup("MALFORMED_TOKEN"),
    streams: [testStream()],
  })
  const activeManifestPath = join(root, "connectors-active.json")
  writeFileSync(activeManifestPath, JSON.stringify({ connectors: active }))
  const exportRoot = join(root, "exports")
  mkdirSync(exportRoot)

  const app = new Hono()
  const logs = []
  const adapter = await registerOptionalPdppSurfaces({
    app,
    devToken: "desktop-token",
    storageRoot: root,
    recordsRoot: root,
    activeManifestPath,
    exportRoot,
    send: message => logs.push(message),
  })
  t.after(() => adapter?.close())

  assert.notEqual(adapter, null)
  assert.deepEqual(
    logs
      .filter(({ message }) => message.includes("mounted "))
      .map(({ message }) => message.match(/mounted ([^ ]+) resource/)[1])
      .sort(),
    ["apple-health", "chatgpt", "github", "whatsapp", "ynab"]
  )
  assert.match(
    logs.find(({ message }) =>
      message.includes("skipped installed profile malformed-pdpp")
    )?.message ?? "",
    /manifest connector key or ID is unsafe/
  )
  assert.equal(
    (await app.request("http://personal.example/v1/streams")).status,
    401
  )
})
