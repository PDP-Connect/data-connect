// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import test from "node:test"
import { startServer } from "../server/index.ts"

type TestServer = Awaited<ReturnType<typeof startServer>>

async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.()
  server.asServer.closeAllConnections()
  server.rsServer.closeAllConnections()
  await Promise.allSettled([
    new Promise(resolve => server.asServer.close(resolve)),
    new Promise(resolve => server.rsServer.close(resolve)),
  ])
}

interface ConnectorBrandIndex {
  readonly brandIcons: Readonly<
    Record<string, { readonly darkUrl?: string; readonly url: string }>
  >
}

test("connector brand icons are served locally as immutable SVG assets", async () => {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  })
  const asUrl = `http://localhost:${server.asPort}`
  try {
    const indexResponse = await fetch(`${asUrl}/connector-index.json`)
    assert.equal(indexResponse.status, 200)
    const index = (await indexResponse.json()) as ConnectorBrandIndex
    const iconUrls: string[] = []
    for (const icon of Object.values(index.brandIcons)) {
      iconUrls.push(icon.url)
      if (icon.darkUrl) {
        iconUrls.push(icon.darkUrl)
      }
    }

    assert.ok(
      iconUrls.length > 0,
      "the vendored manifest index must expose brand icons"
    )
    for (const iconUrl of iconUrls) {
      assert.match(
        iconUrl,
        /^\/connector-brand-icons\/[a-z0-9_-]+(?:\.dark)?\.svg$/
      )
      const response = await fetch(`${asUrl}${iconUrl}`)
      assert.equal(response.status, 200, `${iconUrl} must resolve`)
      assert.match(
        response.headers.get("content-type") ?? "",
        /^image\/svg\+xml(?:;|$)/i
      )
      assert.match(response.headers.get("cache-control") ?? "", /immutable/)
      assert.match(
        await response.text(),
        /<svg\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/i
      )
    }

    assert.equal(
      (await fetch(`${asUrl}/connector-brand-icons/not-a-connector.svg`))
        .status,
      404
    )
  } finally {
    await closeServer(server)
  }
})
