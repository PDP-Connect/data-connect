// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const CARD_FILE = fileURLToPath(
  new URL("./source-setup-catalog.tsx", import.meta.url)
)

test("source cards make package installation the next step before Add account", async () => {
  const source = await readFile(CARD_FILE, "utf8")
  assert.match(
    source,
    /const installModel = installLifecycle \? connectorInstallRowModel\(entry, installLifecycle\) : null/
  )
  assert.match(
    source,
    /const packageNeedsInstall = installModel\?\.activationState === "not_installed"/
  )
  assert.match(
    source,
    /const action = packageNeedsInstall \? null : sourceSetupAction\(entry\)/
  )
  assert.match(source, /packageNeedsInstall && installModel\?\.action/)
  assert.match(source, /data-testid="connector-install-next-step"/)
  assert.match(source, /Install package above/)
})
