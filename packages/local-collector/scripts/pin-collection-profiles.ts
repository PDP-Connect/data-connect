// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pin the Collection Profiles this collector installs.
 *
 * For every connector in `LOCAL_COLLECTOR_DEFINITIONS`, look up the latest
 * release in the signed connector catalog, fetch it through the installer
 * core (manifest by digest, Sigstore signature against the publish workflow
 * identity, every blob against its descriptor), and record the pin. A
 * connector the catalog does not list is reported and left unpinned; the
 * collector then refuses it by name.
 *
 * Writes two things, which must change together:
 *
 *  - `src/generated/collection-profile-pins.generated.ts`, compiled into the
 *    published package; the collector installs exactly these digests.
 *  - `reference-implementation/server/local-collector-profiles/`, the verbatim
 *    profile JSON of each pin (`<key>.json`) plus its pin record
 *    (`<key>.pin.json`). The reference server reads its
 *    local-collector enrollment manifests from here, so the server registers
 *    the same profile the device runs. `test/collection-profiles.test.ts`
 *    fails if the two disagree.
 *
 * Usage (network required):
 *
 *   npm run pin:collection-profiles --workspace @pdpp/local-collector
 *   npm run pin:collection-profiles --workspace @pdpp/local-collector -- --latest
 *   npm run pin:collection-profiles --workspace @pdpp/local-collector -- --version claude-code=0.3.4
 *
 * With no flag the current pins stay where they are: the files are rewritten
 * from the same releases, and a connector with no pin yet takes the catalog's
 * latest. `--latest` moves every connector without a hold to the latest
 * release; review the diff as a connector upgrade. `--version
 * <connector-key>=<version>` (repeatable) pins that connector to a named
 * catalog release and beats a hold. Any other argument, an unknown connector
 * key, or a malformed `--version` is an error.
 *
 * A hold keeps a pin below the latest release, with the reason, in
 * `collection-profile-holds.json`. Holds apply under `--latest`; change a hold
 * in that file in the same change that moves the pin.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
  fetchCatalog,
  fetchResolvedArtifact,
} from "@opendatalabs/data-connectors-tools/installer-core";

import { COLLECTION_PROFILE_PINS } from "../src/generated/collection-profile-pins.generated.ts";
import { LOCAL_COLLECTOR_DEFINITIONS } from "../src/generated/collector-definitions.generated.ts";
import {
  COLLECTION_PROFILE_ENTRYPOINT,
  COLLECTION_PROFILE_MANIFEST,
  type CollectionProfilePin,
  collectionProfileRepository,
} from "../src/managed/collection-profiles.ts";
import { choosePin, parseHolds, parsePinArguments } from "./pin-selection.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pinsModule = path.join(packageRoot, "src", "generated", "collection-profile-pins.generated.ts");
const holdsFile = path.join(packageRoot, "collection-profile-holds.json");
const REFERENCE_PROFILE_DIR = path.resolve(
  packageRoot,
  "..",
  "..",
  "reference-implementation",
  "server",
  "local-collector-profiles"
);

interface CatalogRelease {
  readonly digest: string;
  readonly version: string;
}

interface CatalogConnector {
  readonly connector_key: string;
  readonly latest?: CatalogRelease;
  readonly versions?: readonly CatalogRelease[];
}

interface ResolvedArtifact {
  readonly manifestBuffer: Buffer;
  readonly checksums: { readonly manifest: string; readonly entrypoint: string };
  readonly oci: { readonly digest: string };
}

/** `claude_code` → `claude-code`, the artifact key the catalog uses. */
function connectorKeyFor(connectorId: string): string {
  return connectorId.replaceAll("_", "-");
}

async function main(): Promise<void> {
  const knownKeys = new Set(LOCAL_COLLECTOR_DEFINITIONS.map((definition) => connectorKeyFor(definition.connector_id)));
  const args = parsePinArguments(process.argv.slice(2), knownKeys);
  const holds = parseHolds(JSON.parse(readFileSync(holdsFile, "utf8")));
  const currentVersions = new Map(COLLECTION_PROFILE_PINS.map((pin) => [pin.connectorKey, pin.version]));
  const catalogResult = (await fetchCatalog({})) as { catalog: { connectors: readonly CatalogConnector[] } };
  const catalog = new Map(catalogResult.catalog.connectors.map((entry) => [entry.connector_key, entry]));

  const pins: CollectionProfilePin[] = [];
  const profiles = new Map<string, Buffer>();
  for (const definition of LOCAL_COLLECTOR_DEFINITIONS) {
    const connectorKey = connectorKeyFor(definition.connector_id);
    const listed = catalog.get(connectorKey);
    const choice = choosePin({
      connectorKey,
      args,
      hold: holds.get(connectorKey),
      currentVersion: currentVersions.get(connectorKey),
    });
    const latest =
      choice.kind === "latest" ? listed?.latest : listed?.versions?.find((release) => release.version === choice.version);
    if (!latest) {
      process.stdout.write(
        `unpinned ${definition.connector_id}: the signed catalog lists no ${connectorKey}${choice.kind === "version" ? ` ${choice.version}` : ""}\n`
      );
      continue;
    }
    const repository = collectionProfileRepository({ connectorKey });
    const resolved = (await fetchResolvedArtifact(
      null,
      {
        artifactKind: "pdpp-collection-profile",
        connectorId: definition.connector_id,
        connectorKey,
        entrypointPath: COLLECTION_PROFILE_ENTRYPOINT,
        manifestPath: COLLECTION_PROFILE_MANIFEST,
        oci: { digest: latest.digest, registry: "ghcr.io", repository },
        provenancePath: "provenance.json",
        version: latest.version,
      },
      {
        ociCertificateIdentityResolver: ({ registry, repository: requested }: { registry: string; repository: string }) =>
          registry === "ghcr.io" && requested === repository ? DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY : null,
      }
    )) as ResolvedArtifact;
    pins.push({
      connectorId: definition.connector_id,
      connectorKey,
      version: latest.version,
      digest: resolved.oci.digest,
      profileSha256: resolved.checksums.manifest,
      entrypointSha256: resolved.checksums.entrypoint,
    });
    profiles.set(connectorKey, resolved.manifestBuffer);
    process.stdout.write(`pinned ${definition.connector_id} ${latest.version} ${resolved.oci.digest} (${choice.why})\n`);
  }

  writeFileSync(pinsModule, renderPinsModule(pins));

  mkdirSync(REFERENCE_PROFILE_DIR, { recursive: true });
  for (const name of readdirSync(REFERENCE_PROFILE_DIR)) {
    if (name.endsWith(".json")) {
      rmSync(path.join(REFERENCE_PROFILE_DIR, name));
    }
  }
  for (const [connectorKey, bytes] of profiles) {
    writeFileSync(path.join(REFERENCE_PROFILE_DIR, `${connectorKey}.json`), bytes);
  }
  for (const { connectorKey, version, digest, profileSha256 } of pins) {
    writeFileSync(
      path.join(REFERENCE_PROFILE_DIR, `${connectorKey}.pin.json`),
      `${JSON.stringify({ connector_key: connectorKey, version, digest, profile_sha256: profileSha256 }, null, 2)}\n`
    );
  }
}

function renderPinsModule(pins: readonly CollectionProfilePin[]): string {
  const body = pins.map((pin) => `  ${JSON.stringify(pin, null, 2).replaceAll("\n", "\n  ")},`).join("\n");
  return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/pin-collection-profiles.ts from the signed connector catalog. Each
// entry was fetched and Sigstore-verified when it was pinned. Regenerate with
// \`npm run pin:collection-profiles\`; the reference server's copy under
// reference-implementation/server/local-collector-profiles/ changes with it.

import type { CollectionProfilePin } from "../managed/collection-profiles.ts";

/** The Collection Profile releases this collector installs, in definition order. */
export const COLLECTION_PROFILE_PINS: readonly CollectionProfilePin[] = Object.freeze([
${body}
]);
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
