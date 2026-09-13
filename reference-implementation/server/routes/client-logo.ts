// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Serves bytes the AS already fetched and approved for a consent identity.
 *
 * This endpoint never receives an upstream URL. The challenge model exposes
 * only its opaque cache key, so the owner's browser fetches the logo from the
 * console's own `/oauth` proxy rather than contacting the requesting client
 * or its CDN.
 */

import { readCachedClientLogo } from "../client-logo-cache.ts";

interface RouteRequest {
  readonly params: Record<string, string>;
}

interface RouteResponse {
  send: (body: Uint8Array) => unknown;
  setHeader: (name: string, value: string) => RouteResponse;
  status: (status: number) => RouteResponse;
}

interface AppLike {
  get: (path: string, handler: (req: RouteRequest, res: RouteResponse) => unknown) => AppLike;
}

export function mountClientLogo(app: AppLike): void {
  app.get("/oauth/consent-client-logos/:key", (req, res) => {
    const key = req.params.key;
    const logo = key ? readCachedClientLogo(key) : null;
    if (!logo) {
      return res.status(404).send(new Uint8Array());
    }
    return res
      .setHeader("Cache-Control", "private, no-store")
      .setHeader("Content-Length", String(logo.bytes.byteLength))
      .setHeader("Content-Type", logo.mediaType)
      .setHeader("X-Content-Type-Options", "nosniff")
      .status(200)
      .send(logo.bytes);
  });
}
