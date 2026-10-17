// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const CONSOLE_CLIENT_FILE = fileURLToPath(
  new URL("../lib/ref-client.ts", import.meta.url)
)
const RI_ROUTE_FILE = fileURLToPath(
  new URL(
    "../../../../../../reference-implementation/server/routes/ref-static-secret-draft-connection.ts",
    import.meta.url
  )
)

test("Add account uses the mounted RI static-secret setup endpoint", async () => {
  const [consoleClient, riRoute] = await Promise.all([
    readFile(CONSOLE_CLIENT_FILE, "utf8"),
    readFile(RI_ROUTE_FILE, "utf8"),
  ])

  assert.match(
    consoleClient,
    /`\/_ref\/connectors\/\$\{encodeURIComponent\(connectorId\)\}\/static-secret-setup`/
  )
  assert.match(
    riRoute,
    /app\.get\(\s*"\/_ref\/connectors\/:connectorId\/static-secret-setup"/
  )
  assert.match(riRoute, /res\.status\(200\)\.json\(setup\)/)
})
