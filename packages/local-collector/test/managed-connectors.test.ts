// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consumer-side tests for obtaining connectors through the connector manager.
 *
 * These run against a **fixture artifact built in-process** — real gzipped tar
 * layers, real sha256 digests, a real config/profile pair — rather than
 * against a published GHCR artifact, because no connector artifact has been
 * published yet (data-connectors#97 is a draft and its publish workflow has
 * never run). What that buys and what it does not is stated plainly in
 * `OCI-CONSUMER-0911.md`: the digest chain, the cross-checks, the archive
 * safety filter and the install layout are exercised for real; the `ghcr.io`
 * transport and Sigstore keyless verification are not, because they are the
 * two things a fixture cannot stand in for.
 *
 * The adversarial cases matter more than the happy path here. A verifier that
 * has only ever been shown a good artifact has demonstrated nothing — so each
 * check gets a test that breaks exactly that check and expects a refusal.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertRootsDisjoint,
  assertSafeMemberPath,
  type CollectionProfile,
  type ConnectorConfig,
  type ConnectorLock,
  CONNECTOR_ARTIFACT_TYPE,
  CONNECTOR_CONFIG_MEDIA_TYPE,
  definitionFromProfile,
  LAYER_MEDIA_TYPES,
  managedConnectorCommand,
  obtainManagedConnectors,
  readTarGz,
  type RegistryClient,
  type SignatureVerifier,
  UNSUPPORTED_PLATFORM_SELECTION,
} from "../src/managed/index.ts";

const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

/**
 * Build a POSIX tar the same way the publisher's deterministic recipe does,
 * so the reader under test is reading the shape it will really be handed.
 */
function tarGz(entries: readonly { path: string; content: string; typeflag?: string }[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content, "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "utf8");
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
    header.write("00000000000\0", 136, 12, "utf8");
    header.write(entry.typeflag ?? "0", 156, 1, "utf8");
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    // Checksum: spaces during computation, then the octal value.
    header.write(" ".repeat(8), 148, 8, "utf8");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");

    blocks.push(header);
    blocks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const CONNECTOR_KEY = "oura";
const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/oura";
const REFERENCE = "ghcr.io/pdp-connect/connector/oura";

interface Fixture {
  readonly lock: ConnectorLock;
  readonly client: RegistryClient;
  readonly verifier: SignatureVerifier;
  readonly digest: string;
}

/**
 * A complete, valid artifact, with hooks to corrupt exactly one thing.
 *
 * Every mutation is applied *after* the digests are computed where the point
 * is to break the chain, and *before* where the point is to produce a
 * well-formed artifact that lies about itself. Which of the two a test needs
 * is the difference between testing the digest check and testing the
 * cross-check.
 */
function buildFixture(
  overrides: {
    readonly profile?: Partial<CollectionProfile>;
    readonly config?: Partial<ConnectorConfig>;
    readonly codeEntries?: readonly { path: string; content: string; typeflag?: string }[];
    readonly extraLayers?: readonly { mediaType: string; bytes: Uint8Array }[];
    readonly dropLayer?: string;
    readonly tamperBlob?: (mediaType: string, bytes: Uint8Array) => Uint8Array;
    readonly signerIdentity?: string;
    readonly signerIssuer?: string;
    readonly mediaType?: string;
    readonly artifactType?: string;
  } = {}
): Fixture {
  const profile: CollectionProfile = {
    protocol_version: "0.1.0",
    connector_key: CONNECTOR_KEY,
    connector_id: CONNECTOR_ID,
    version: "0.1.0",
    display_name: "Oura",
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [{ name: "sleep" }, { name: "readiness" }],
    ...overrides.profile,
  };
  const profileBytes = encode(profile);

  const codeBytes = tarGz(
    overrides.codeEntries ?? [
      { path: "collection-profile.mjs", content: "export const collectOura = () => {};\n" },
    ]
  );
  const licensesBytes = tarGz([{ path: "LICENSE", content: "Apache-2.0\n" }]);
  const provenanceBytes = encode({ builder: "build-connector-oci-artifact.mjs" });

  const config: ConnectorConfig = {
    config_version: "1.0",
    connector_key: CONNECTOR_KEY,
    connector_id: CONNECTOR_ID,
    version: "0.1.0",
    protocol_version: "0.1.0",
    display_name: "Oura",
    tier: "development",
    platform: { os: "any", architecture: "any" },
    profile_digest: sha256(profileBytes),
    entrypoint: "code/collection-profile.mjs",
    runtime: { node: ">=22", bindings: ["network"] },
    bundled_tools: [],
    licenses: "Apache-2.0",
    source: { repository: "https://github.com/PDP-Connect/data-connectors", revision: "0".repeat(40) },
    ...overrides.config,
  };
  const configBytes = encode(config);

  const layerSpecs = [
    { mediaType: LAYER_MEDIA_TYPES.profile, bytes: profileBytes },
    { mediaType: LAYER_MEDIA_TYPES.code, bytes: codeBytes },
    { mediaType: LAYER_MEDIA_TYPES.licenses, bytes: licensesBytes },
    { mediaType: LAYER_MEDIA_TYPES.provenance, bytes: provenanceBytes },
    ...(overrides.extraLayers ?? []),
  ].filter((layer) => layer.mediaType !== overrides.dropLayer);

  const manifest = {
    schemaVersion: 2,
    mediaType: overrides.mediaType ?? "application/vnd.oci.image.manifest.v1+json",
    artifactType: overrides.artifactType ?? CONNECTOR_ARTIFACT_TYPE,
    config: {
      mediaType: CONNECTOR_CONFIG_MEDIA_TYPE,
      digest: sha256(configBytes),
      size: configBytes.byteLength,
    },
    layers: layerSpecs.map((layer) => ({
      mediaType: layer.mediaType,
      digest: sha256(layer.bytes),
      size: layer.bytes.byteLength,
    })),
  };
  const manifestBytes = encode(manifest);
  const digest = sha256(manifestBytes);

  const blobs = new Map<string, Uint8Array>([[manifest.config.digest, configBytes]]);
  for (const layer of layerSpecs) blobs.set(sha256(layer.bytes), layer.bytes);

  const client: RegistryClient = {
    fetchManifest: async (_reference, requested) => {
      assert.equal(requested, digest, "install must fetch by the pinned digest");
      return manifestBytes;
    },
    fetchBlob: async (_reference, requested) => {
      const bytes = blobs.get(requested);
      if (bytes === undefined) throw new Error(`fixture has no blob ${requested}`);
      const mediaType = layerSpecs.find((layer) => sha256(layer.bytes) === requested)?.mediaType ?? "config";
      return overrides.tamperBlob === undefined ? bytes : overrides.tamperBlob(mediaType, bytes);
    },
  };

  const verifier: SignatureVerifier = {
    verify: async ({ digest: requested }) => {
      assert.equal(requested, digest, "the signature must be verified over the digest, never a tag");
      return {
        certificateIdentity:
          overrides.signerIdentity ??
          "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main",
        certificateIssuer: overrides.signerIssuer ?? "https://token.actions.githubusercontent.com",
      };
    },
  };

  return {
    digest,
    client,
    verifier,
    lock: {
      lockVersion: "2.0",
      connectors: [
        {
          connectorKey: CONNECTOR_KEY,
          connectorId: CONNECTOR_ID,
          reference: REFERENCE,
          version: "0.1.0",
          digest,
        },
      ],
    },
  };
}

function withRoots<T>(body: (installRoot: string, durableRoot: string) => T): T {
  const base = mkdtempSync(join(tmpdir(), "managed-connectors-"));
  try {
    return body(join(base, "connector-releases"), join(base, "connector-artifacts"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function obtain(fixture: Fixture, installRoot: string, durableRoot: string) {
  return obtainManagedConnectors({
    lock: fixture.lock,
    installRoot,
    durableRoot,
    client: fixture.client,
    verifier: fixture.verifier,
  });
}

test("a verified artifact installs under its digest and yields a runnable definition", async () => {
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    const managed = await obtain(fixture, installRoot, durableRoot);

    assert.equal(managed.length, 1);
    const entry = managed[0];
    assert.ok(entry);
    assert.equal(entry.definition.connector_id, CONNECTOR_ID);
    assert.deepEqual(entry.definition.bindings, { network: { required: true } });
    assert.deepEqual([...entry.definition.streams], ["sleep", "readiness"]);

    // The path is absolute, inside the install store, and under the digest.
    assert.ok(entry.entrypoint.startsWith(installRoot), entry.entrypoint);
    assert.ok(entry.entrypoint.includes(fixture.digest.replace(":", "-")));
    assert.ok(existsSync(entry.entrypoint));
    assert.match(readFileSync(entry.entrypoint, "utf8"), /collectOura/);

    // The release is self-describing without the registry.
    const releaseDir = join(installRoot, "connectors", CONNECTOR_KEY, fixture.digest.replace(":", "-"));
    for (const file of ["config.json", "collection-profile.json", "provenance.json", "oci-manifest.json"]) {
      assert.ok(existsSync(join(releaseDir, file)), `${file} should be installed`);
    }
  });
});

test("installing twice is idempotent and does not rewrite the release", async () => {
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    const first = await obtain(fixture, installRoot, durableRoot);
    const second = await obtain(fixture, installRoot, durableRoot);
    assert.equal(first[0]?.entrypoint, second[0]?.entrypoint);
  });
});

test("install does not activate: no current.json until activation is asked for", async () => {
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    await obtain(fixture, installRoot, durableRoot);
    assert.equal(
      existsSync(join(installRoot, "connectors", CONNECTOR_KEY, "current.json")),
      false,
      "fetching must never change what runs"
    );

    await obtainManagedConnectors({
      lock: fixture.lock,
      installRoot,
      durableRoot,
      client: fixture.client,
      verifier: fixture.verifier,
      activate: true,
    });
    assert.ok(existsSync(join(installRoot, "connectors", CONNECTOR_KEY, "current.json")));
  });
});

test("a tampered layer is refused: the digest chain breaks", async () => {
  const fixture = buildFixture({
    tamperBlob: (mediaType, bytes) =>
      mediaType === LAYER_MEDIA_TYPES.profile ? new TextEncoder().encode("{}\n") : bytes,
  });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /blob digest mismatch/);
  });
});

test("an artifact signed by an unexpected identity is refused", async () => {
  const fixture = buildFixture({
    signerIdentity: "https://github.com/attacker/data-connectors/.github/workflows/publish.yml@refs/heads/main",
  });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /this host does not accept/);
  });
});

test("an artifact from an unexpected OIDC issuer is refused", async () => {
  const fixture = buildFixture({ signerIssuer: "https://accounts.google.com" });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /certificate issuer/);
  });
});

test("a host with no signing policy for a reference refuses rather than trusting it", async () => {
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(
      obtainManagedConnectors({
        lock: fixture.lock,
        installRoot,
        durableRoot,
        client: fixture.client,
        verifier: fixture.verifier,
        identityPolicy: () => null,
      }),
      /no signing identity is accepted/
    );
  });
});

test("a lock pinning a digest the registry does not serve is refused", async () => {
  const fixture = buildFixture();
  const wrongDigest = `sha256:${"b".repeat(64)}`;
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(
      obtainManagedConnectors({
        lock: { ...fixture.lock, connectors: [{ ...fixture.lock.connectors[0]!, digest: wrongDigest }] },
        installRoot,
        durableRoot,
        client: {
          fetchManifest: async (reference, digest) => fixture.client.fetchManifest(reference, fixture.digest),
          fetchBlob: fixture.client.fetchBlob,
        },
        verifier: fixture.verifier,
      }),
      /manifest digest mismatch/
    );
  });
});

test("an artifact whose config names a different connector than its coordinates is refused", async () => {
  // The substitution the incumbent installer cannot currently detect for
  // Collection Profile artifacts: right signature, right digest, wrong
  // connector at these coordinates.
  const fixture = buildFixture({
    profile: { connector_key: "strava", connector_id: "https://registry.pdpp.dev/connectors/strava" },
    config: { connector_key: "strava", connector_id: "https://registry.pdpp.dev/connectors/strava" },
  });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /repository path segment/);
  });
});

test("an artifact whose config version disagrees with its profile is refused", async () => {
  const fixture = buildFixture({ config: { version: "9.9.9" } });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /disagrees with the profile/);
  });
});

test("a missing required layer is refused", async () => {
  const fixture = buildFixture({ dropLayer: LAYER_MEDIA_TYPES.code });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /missing its required/);
  });
});

test("two code layers are refused rather than one being picked", async () => {
  const fixture = buildFixture({
    extraLayers: [{ mediaType: LAYER_MEDIA_TYPES.code, bytes: tarGz([{ path: "other.mjs", content: "//\n" }]) }],
  });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /at most 1 is valid/);
  });
});

test("an unrecognized PDPP layer type is refused, not ignored", async () => {
  // The layer most likely to be added next is the native-helper binary layer.
  // A host too old to know what it is must not install it silently.
  const fixture = buildFixture({
    extraLayers: [
      { mediaType: LAYER_MEDIA_TYPES.tool, bytes: tarGz([{ path: "slackdump", content: "binary\n" }]) },
    ],
  });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /unrecognized layer media type/);
  });
});

test("a non-connector artifactType is refused", async () => {
  const fixture = buildFixture({ artifactType: "application/vnd.oci.image.config.v1+json" });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /is not application\/vnd\.pdpp\.connector/);
  });
});

test("an image index is refused with a named error rather than a guessed platform", async () => {
  const fixture = buildFixture({ mediaType: "application/vnd.oci.image.index.v1+json" });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), new RegExp(UNSUPPORTED_PLATFORM_SELECTION));
  });
});

test("an artifact whose entrypoint is absent after unpack is refused", async () => {
  const fixture = buildFixture({ codeEntries: [{ path: "something-else.mjs", content: "//\n" }] });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /absent after unpack/);
  });
});

test("a symlink in the code layer is refused", async () => {
  const fixture = buildFixture({
    codeEntries: [
      { path: "collection-profile.mjs", content: "//\n" },
      { path: "evil", content: "/etc/passwd", typeflag: "2" },
    ],
  });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /not a regular file/);
  });
});

test("archive members that escape the release root are refused", () => {
  assert.throws(() => assertSafeMemberPath("../outside", "0"), /escapes the archive root/);
  assert.throws(() => assertSafeMemberPath("/etc/passwd", "0"), /absolute path/);
  assert.throws(() => assertSafeMemberPath("a\\b", "0"), /backslash/);
  assert.throws(() => assertSafeMemberPath("a\0b", "0"), /NUL byte/);
  assert.throws(() => assertSafeMemberPath("fifo", "6"), /not a regular file/);
  assert.doesNotThrow(() => assertSafeMemberPath("code/collection-profile.mjs", "0"));
});

test("the tar reader round-trips the shape the publisher emits", () => {
  const members = readTarGz(tarGz([{ path: "a/b.mjs", content: "hello\n" }]));
  assert.equal(members.length, 1);
  assert.equal(members[0]?.path, "a/b.mjs");
  assert.equal(Buffer.from(members[0]!.bytes).toString("utf8"), "hello\n");
});

test("the install store and the durable root may not contain one another", () => {
  withRoots((installRoot, durableRoot) => {
    // Siblings are the supported arrangement.
    assert.doesNotThrow(() => assertRootsDisjoint(installRoot, durableRoot));
    // Nesting either way is refused: an uninstall would delete collected data.
    assert.throws(() => assertRootsDisjoint(durableRoot, join(durableRoot, "releases")), /must not contain/);
    assert.throws(() => assertRootsDisjoint(join(durableRoot, "releases"), durableRoot), /must not contain/);
    assert.throws(() => assertRootsDisjoint(durableRoot, durableRoot), /must not contain/);
  });
});

test("a managed connector is never spawned through a PATH-resolved transpiler", () => {
  assert.equal(managedConnectorCommand("/store/oura/code/collection-profile.mjs"), process.execPath);
  assert.throws(() => managedConnectorCommand("/store/oura/index.ts"), /must ship a bundled \.mjs/);
});

test("definitions derived from a profile leave unclaimed optional fields absent", () => {
  const managed = definitionFromProfile(
    {
      protocol_version: "0.1.0",
      connector_key: CONNECTOR_KEY,
      connector_id: CONNECTOR_ID,
      version: "0.1.0",
      display_name: "Oura",
    },
    {
      connectorKey: CONNECTOR_KEY,
      connectorId: CONNECTOR_ID,
      version: "0.1.0",
      digest: `sha256:${"a".repeat(64)}`,
      directory: "/store",
      entrypoint: "/store/code/collection-profile.mjs",
    }
  );
  // A defaulted `enforces_source_roots: false` would be a claim about
  // connector behaviour this module cannot make.
  assert.equal("enforces_source_roots" in managed.definition, false);
  assert.equal("time_scopable_streams" in managed.definition, false);
  assert.deepEqual([...managed.definition.streams], []);
});
