// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ShippedManifestEntry {
  readonly file: string;
  readonly manifest: unknown;
}

const MANIFEST_DIR = fileURLToPath(new URL("../fixtures/shipped-manifests/connectors/", import.meta.url));

/** Reads the pinned upstream manifests with the package export's entry shape. */
export function readShippedManifests(): readonly ShippedManifestEntry[] {
  return readdirSync(MANIFEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => ({
      file: `${name}.json`,
      manifest: JSON.parse(readFileSync(join(MANIFEST_DIR, name, "manifest.json"), "utf8")),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
}
