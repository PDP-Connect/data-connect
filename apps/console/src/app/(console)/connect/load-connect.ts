// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { getReferencePublicOrigin } from "../lib/owner-token.ts";
import { loadApps } from "../grants/load-apps.ts";
export async function loadConnect(demo?: string) {
  const practice = process.env.NODE_ENV !== "production" && Boolean(demo);
  const [origin, result] = await Promise.all([
    practice
      ? Promise.resolve(demo === "local" ? "http://192.168.1.50:8080" : "https://data.northwind.example")
      : getReferencePublicOrigin(),
    loadApps(practice ? (demo === "empty" || demo === "local" ? "empty" : demo) : undefined),
  ]);
  return {
    origin,
    apps: result.apps
      .filter((app) => app.state === "reading")
      .sort((a, b) => (b.since || "").localeCompare(a.since || "")),
  };
}
