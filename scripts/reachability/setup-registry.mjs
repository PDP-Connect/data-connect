// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto"
import { copyFile, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fakeRegistry } from "@tnunamak/gozar/testing"

export async function createSetupRegistry(dir) {
  const id = `fixture-${randomUUID()}`
  const registry = await fakeRegistry({
    dir,
    id,
    label: "Workshop route",
    kinds: ["attached"],
    reach: "this-device",
    transport: "http",
    protocols: [],
    facts: [
      {
        id: "fixture.inventory",
        group: "inventory",
        label: "Fixture inventory note",
        known: true,
        affectsConsent: false,
        source: "fixture",
        value: "Inventory only",
        asOf: null,
      },
    ],
  })
  const folder = join(registry.root, "providers", id)
  const file = join(folder, "world.json")
  await rename(join(folder, "index.mjs"), join(folder, "base.mjs"))
  await copyFile(
    new URL(
      "../../reference-implementation/test/fixtures/reachability/setup-provider.mjs",
      import.meta.url
    ),
    join(folder, "index.mjs")
  )
  const readWorld = async () => JSON.parse(await readFile(file, "utf8"))
  await writeFile(
    file,
    JSON.stringify({
      grant: "pending",
      effects: [],
      foreign: randomUUID(),
      handoff: `https://fixture.invalid/enroll?session=${randomUUID()}`,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    })
  )
  return {
    ...registry,
    id,
    readWorld,
    updateWorld: async patch =>
      writeFile(file, JSON.stringify({ ...(await readWorld()), ...patch })),
  }
}
