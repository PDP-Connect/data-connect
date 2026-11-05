// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const CARD_FILE = fileURLToPath(
  new URL("./source-setup-catalog.tsx", import.meta.url)
)

const PRESENTATION_FILE = fileURLToPath(
  new URL("../lib/source-setup-presentation.ts", import.meta.url)
)

test("source cards make package installation the next step before Add account", async () => {
  const source = await readFile(CARD_FILE, "utf8")
  assert.match(source, /packageNeedsInstall,/)
  assert.match(
    source,
    /sourceSetupCardModel\(entry, installLifecycle, installCatalogTransientlyUnavailable\)/
  )
  const presentation = await readFile(PRESENTATION_FILE, "utf8")
  assert.match(
    presentation,
    /packageNeedsInstall: packageActionAvailable && installModel\?\.activationState === "not_installed"/
  )
  assert.match(source, /packageNeedsInstall && installModel\?\.action/)
  assert.match(source, /data-testid="connector-install-next-step"/)
  assert.match(source, /Install package first/)
})
