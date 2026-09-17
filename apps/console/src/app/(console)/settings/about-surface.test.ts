// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))

test("the settings page mounts the About surface with product metadata", async () => {
  const [page, about] = await Promise.all([
    readFile(`${HERE}page.tsx`, "utf8"),
    readFile(`${HERE}about-section.tsx`, "utf8"),
  ])

  assert.match(page, /<AboutSection identity=\{identity\} \/>/)
  for (const field of [
    "Product",
    "Version",
    "Build",
    "Protocol",
    "Copyright",
  ]) {
    assert.match(
      about,
      new RegExp(`>${field}<`),
      `${field} must be visible in About`
    )
  }
})

test("the About surface exposes the researched product resources", async () => {
  const about = await readFile(`${HERE}about-section.tsx`, "utf8")

  for (const label of [
    "Docs",
    "Source",
    "Apache-2.0 license",
    "Third-party notices",
    "Support",
  ]) {
    assert.match(
      about,
      new RegExp(`>\\s*${label}\\s*<`),
      `${label} link must be visible in About`
    )
  }
  assert.match(about, /TODO\(legal\): confirm the canonical privacy-policy URL/)
  assert.match(about, /TODO\(legal\): replace the repository NOTICE link/)
})

test("the product surface is fixed to DataConnect with PDPP attribution", async () => {
  const [identity, manifest] = await Promise.all([
    readFile(`${HERE}../lib/product-identity.ts`, "utf8"),
    readFile(`${HERE}../../manifest.ts`, "utf8"),
  ])
  assert.match(identity, /return DATACONNECT_PRODUCT_IDENTITY/)
  assert.doesNotMatch(identity, /process\.env|PRODUCT_IDENTITY_ENV/)
  assert.match(manifest, /\/brand\/dataconnect-mark\.svg/)
  assert.match(manifest, /name: `\$\{identity\.name\} Owner Console`/)
  assert.doesNotMatch(manifest, /pdpp-favicon/)
})
