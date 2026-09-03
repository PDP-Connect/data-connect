// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { loadConnectorBrandIndex } from "../connector-brand-index.ts";
interface RouteResponse {
  json: (body: unknown) => unknown;
}

type RouteHandler = (_req: unknown, res: RouteResponse) => unknown;

interface AppLike {
  get: (path: string, handler: RouteHandler) => AppLike;
}

/** Serves the manifest-derived connector index field used by Console. */
export function mountConnectorBrandIndex(app: AppLike): void {
  app.get("/connector-index.json", (_req: unknown, res: RouteResponse) => res.json(loadConnectorBrandIndex()));
}
