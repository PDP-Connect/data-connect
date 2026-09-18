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
      new RegExp(`<KVRow k="${field}"`),
      `${field} must be visible in About`
    )
  }
})

test("the About metadata is a quiet KV list, not a bordered card", async () => {
  const about = await readFile(`${HERE}about-section.tsx`, "utf8")

  assert.match(about, /<KV>/, "metadata must use the shared KV primitive")
  assert.doesNotMatch(
    about,
    /rounded-md border/,
    "About metadata must not sit in a bordered box"
  )
})

test("the About copy states the protocol relationship once, not twice", async () => {
  const about = await readFile(`${HERE}about-section.tsx`, "utf8")

  const poweredByOccurrences = about.match(/is powered by/g) ?? []
  const usesPdppOccurrences = about.match(/uses PDPP to keep/g) ?? []
  assert.equal(
    poweredByOccurrences.length + usesPdppOccurrences.length,
    0,
    "the redundant 'powered by' / 'uses PDPP to keep' pair must not both appear"
  )
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

test("every outbound link in the About surface opens via OpenExternalLink, not a bare anchor", async () => {
  const about = await readFile(`${HERE}about-section.tsx`, "utf8")

  assert.match(
    about,
    /import \{ OpenExternalLink \} from "\.\.\/components\/open-external-link\.tsx"/
  )
  assert.doesNotMatch(
    about,
    /<a\s/,
    "About must route external links through OpenExternalLink, not a bare <a>"
  )
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
