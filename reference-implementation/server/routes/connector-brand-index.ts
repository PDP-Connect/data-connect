// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { loadConnectorBrandIndex } from "../connector-brand-index.ts"
import { readConnectorBrandIcon } from "../connector-brand-icons.ts"

interface RouteRequest {
  readonly params: Record<string, string>
}

interface RouteResponse {
  json: (body: unknown) => unknown
  send: (body: Uint8Array) => unknown
  setHeader: (name: string, value: string) => RouteResponse
  status: (status: number) => RouteResponse
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown

interface AppLike {
  get: (path: string, handler: RouteHandler) => AppLike
}

/** Serves the manifest-derived connector index field used by Console. */
export function mountConnectorBrandIndex(app: AppLike): void {
  app.get("/connector-index.json", (_req: unknown, res: RouteResponse) =>
    res.json(loadConnectorBrandIndex())
  )
  app.get("/connector-brand-icons/:asset", (req, res) => {
    const asset = req.params.asset
    const match = asset
      ? /^(?<connectorKey>[a-z0-9_-]+)(?<dark>\.dark)?\.svg$/.exec(asset)
      : null
    const connectorKey = match?.groups?.connectorKey
    const icon = connectorKey
      ? readConnectorBrandIcon(connectorKey, Boolean(match?.groups?.dark))
      : null
    if (!icon) {
      return res.status(404).send(new Uint8Array())
    }
    return res
      .setHeader("Cache-Control", "public, max-age=31536000, immutable")
      .setHeader("Content-Length", String(icon.byteLength))
      .setHeader("Content-Type", "image/svg+xml")
      .setHeader("X-Content-Type-Options", "nosniff")
      .status(200)
      .send(icon)
  })
}
