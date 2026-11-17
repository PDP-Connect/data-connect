// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { fakeRegistry } from "@tnunamak/gozar/testing"
import { setupApproval } from "./journey-support.mjs"
import { createEffectFixtures } from "./effect-fixtures.ts"
import { createEffectFixtureHost } from "./testing-effects.mjs"
import { FixtureSecretBackend } from "../../reference-implementation/test/fixtures/reachability/secret-backend.ts"

const specification = JSON.parse(
  await readFile(
    new URL(
      "../../reference-implementation/test/fixtures/reachability/install-provider.json",
      import.meta.url
    ),
    "utf8"
  )
)
const effectData = JSON.parse(
  await readFile(
    new URL(
      "../../reference-implementation/test/fixtures/reachability/effects.json",
      import.meta.url
    ),
    "utf8"
  )
)
const artifactBytes = Buffer.from(effectData["artifact/fetch"].content)
const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex")

// `capability` is the observation the host reports for installer.execute;
// leaving it undefined declares nothing about that capability.
async function setupCase({ capability, expectedSha = artifactSha256 }) {
  const parent = join(homedir(), ".tmp", "ra")
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, "install-"))
  const manifestSpec = structuredClone(specification)
  manifestSpec.dir = join(root, "r")
  manifestSpec.setupActions[0].artifact.sha256 = expectedSha
  const registry = await fakeRegistry(manifestSpec)
  const definitionPath = join(
    registry.root,
    "providers",
    manifestSpec.id,
    "definition.json"
  )
  const definition = JSON.parse(await readFile(definitionPath, "utf8"))
  definition.adapter.effectOperations = [
    { kind: "artifact", operation: "fetch" },
    { kind: "artifact", operation: "execute" },
  ]
  await writeFile(definitionPath, JSON.stringify(definition))
  const backend = new FixtureSecretBackend()
  const effects = createEffectFixtures()
  const harness = await createEffectFixtureHost(
    {
      manifest: registry.manifest,
      root: registry.root,
      secretBackend: backend,
      hostCapabilities:
        capability === undefined ? {} : { "installer.execute": capability },
    },
    effects.effects
  )
  return {
    root,
    registry,
    backend,
    effects,
    gozar: harness.gozar,
    close: harness.close,
  }
}

async function runInstall(fixture) {
  const home = join(fixture.root, "g"),
    owner = "fixture-owner"
  const provider = (await fixture.gozar.listProviders({ home, owner }))
    .providers[0]
  const draft = await fixture.gozar.beginConfigurationDraft({
    home,
    owner,
    providerId: provider.providerId,
    expectedConfigurationRevision: provider.configuration.revision,
  })
  const action = draft.configuration.actions.find(
    candidate => candidate.kind === "install-artifact"
  )
  assert.ok(action)
  return fixture.gozar.runSetupAction({
    home,
    owner,
    providerId: provider.providerId,
    draftId: draft.draftId,
    expectedConfigurationRevision: draft.configuration.revision,
    actionId: action.id,
    approval: setupApproval(action),
  })
}

const refusals = [
  {
    name: "host refusal of installer.execute executes nothing",
    capability: { known: true, value: false },
    code: "host_policy_denied",
  },
  {
    name: "an undeclared installer.execute capability executes nothing",
    capability: undefined,
    code: "unsupported",
  },
  {
    name: "artifact hash mismatch executes nothing through the public testing boundary",
    capability: { known: true, value: true },
    expectedSha: "0".repeat(64),
    code: "artifact_integrity_failed",
  },
]
for (const { name, capability, expectedSha, code } of refusals)
  test(name, async () => {
    const fixture = await setupCase({ capability, expectedSha })
    try {
      await assert.rejects(runInstall(fixture), { code })
      assert.equal(fixture.effects.artifactExecutions, 0)
      assert.ok(!fixture.backend.trace.includes("put"))
    } finally {
      await fixture.close()
      await fixture.registry.cleanup()
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

test("approved artifact bytes pass the trusted SHA check before fixture execution", async () => {
  const fixture = await setupCase({ capability: { known: true, value: true } })
  try {
    const result = await runInstall(fixture)
    assert.equal(result.state, "complete")
    assert.equal(fixture.effects.artifactExecutions, 1)
  } finally {
    await fixture.close()
    await fixture.registry.cleanup()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
