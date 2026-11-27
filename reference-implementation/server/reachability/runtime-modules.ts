// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { GozarOptions } from "@tnunamak/gozar";

// Resolve from the server's installed tree, including the desktop's staged tree.
// A missing bundle is host-managed and unavailable; it is never an install offer.
export function bundledRuntimeModules(
  resolveManifest: () => string = () => createRequire(import.meta.url).resolve("@ngrok/ngrok/package.json")
): NonNullable<GozarOptions["runtimeModules"]> {
  try {
    return { "@ngrok/ngrok": { kind: "bundled", version: "1.7.0", path: dirname(resolveManifest()) } };
  } catch {
    return { "@ngrok/ngrok": { kind: "host-managed" } };
  }
}
