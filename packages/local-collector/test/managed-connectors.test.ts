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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import {
  assertContainedEntrypoint,
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
  PDP_CONNECT_CONNECTOR_IDENTITY,
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

/**
 * Run `body` against a fresh pair of sibling roots and remove them afterwards.
 *
 * `async` and `await`ing deliberately. A synchronous `try { return body(...) }
 * finally { rmSync(...) }` type-checks for an `async` callback — `T` binds to
 * the returned promise — but `finally` then runs the moment the callback first
 * suspends, so the roots are deleted while the operation under test is still
 * running. Most tests here `await obtain(...)` as their first statement, and
 * the two containment tests stage a file the escape is supposed to reach; a
 * cleanup that fires early turns every escape into a file that merely is not
 * there, which is the wrong reason to refuse and would pass whether the
 * containment check existed or not.
 */
async function withRoots<T>(body: (installRoot: string, durableRoot: string) => T | Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), "managed-connectors-"));
  try {
    return await body(join(base, "connector-releases"), join(base, "connector-artifacts"));
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

test("activation does not write through a symlink planted at its temporary leaf", async () => {
  // The activation pointer's *parent* was checked and its *leaf* was not, so a
  // symlink planted at the predictable `current.json.tmp-<pid>` was followed:
  // activation JSON replaced a durable archive's bytes and `current.json` ended
  // up a symlink whose realpath was still that archive. No race was needed, so
  // the concurrent-replacement qualification did not cover it.
  //
  // The assertion that matters is byte-identity of the archive, not the shape
  // of the error: a fix that merely renamed the temporary file would still be
  // wrong if some other predictable path could be planted.
  const fixture = buildFixture();
  const ARCHIVE = "COLLECTED-DATA\n";
  await withRoots(async (installRoot, durableRoot) => {
    mkdirSync(durableRoot, { recursive: true });
    const archive = join(durableRoot, "archive.json");
    writeFileSync(archive, ARCHIVE);

    // Plant the leaf the old implementation would have written through.
    const pointerDir = join(installRoot, "connectors", CONNECTOR_KEY);
    mkdirSync(pointerDir, { recursive: true });
    symlinkSync(archive, join(pointerDir, `current.json.tmp-${process.pid}`));

    await obtainManagedConnectors({
      lock: fixture.lock,
      installRoot,
      durableRoot,
      client: fixture.client,
      verifier: fixture.verifier,
      activate: true,
    });

    assert.equal(readFileSync(archive, "utf8"), ARCHIVE, "the durable archive must be byte-identical after activation");

    // …and the pointer that was written is a real file in the store, not a
    // symlink that resolves back out into the durable tree.
    const pointer = join(pointerDir, "current.json");
    assert.equal(lstatSync(pointer).isSymbolicLink(), false, "the activation pointer must not be a symlink");
    assert.equal(
      JSON.parse(readFileSync(pointer, "utf8")).digest,
      fixture.digest,
      "the pointer must hold the activation record"
    );
  });
});

test("a failed activation leaves no temporary leaf behind and does not touch durable data", async () => {
  // The counterpart to the test above: activation can still fail *after* the
  // temporary is created — here the pointer path is a non-empty directory, so
  // the rename fails with EISDIR. A leaked `current.json.tmp-*` would be a path
  // some later caller could find, and the whole point of creating it fresh is
  // that no such path is lying around between runs.
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    mkdirSync(durableRoot, { recursive: true });
    const archive = join(durableRoot, "archive.json");
    writeFileSync(archive, "COLLECTED-DATA\n");

    const pointerDir = join(installRoot, "connectors", CONNECTOR_KEY);
    mkdirSync(pointerDir, { recursive: true });
    mkdirSync(join(pointerDir, "current.json"), { recursive: true });
    writeFileSync(join(pointerDir, "current.json", "occupant"), "x\n");

    await assert.rejects(
      obtainManagedConnectors({
        lock: fixture.lock,
        installRoot,
        durableRoot,
        client: fixture.client,
        verifier: fixture.verifier,
        activate: true,
      })
    );

    assert.equal(readFileSync(archive, "utf8"), "COLLECTED-DATA\n", "a failed activation must not touch durable data");
    assert.deepEqual(
      readdirSync(pointerDir).filter((entry) => entry.includes("current.json.tmp-")),
      [],
      "a failed activation must not leave its temporary leaf behind"
    );
  });
});

test("activation creates its temporary leaf exclusively, so an occupied path is refused not followed", async () => {
  // The randomized name means an attacker cannot know which leaf to plant, so
  // the end-to-end test above cannot exercise a *collision* — it can only prove
  // the old predictable name no longer works. This proves the other half
  // directly: the create-or-fail open is what refuses, so even a leaf that
  // somehow already exists is never written through.
  //
  // Driven against `writeFileSync`'s real flag semantics rather than a mock,
  // because the guarantee is the kernel's `O_EXCL`, not ours.
  const base = mkdtempSync(join(tmpdir(), "managed-connectors-excl-"));
  try {
    const archive = join(base, "archive.json");
    writeFileSync(archive, "COLLECTED-DATA\n");
    const leaf = join(base, "current.json.tmp-planted");
    symlinkSync(archive, leaf);

    assert.throws(
      () => writeFileSync(leaf, "ACTIVATION-JSON\n", { flag: "wx" }),
      (error: NodeJS.ErrnoException) => error.code === "EEXIST",
      "the create-or-fail open must refuse a planted leaf rather than follow it"
    );
    assert.equal(readFileSync(archive, "utf8"), "COLLECTED-DATA\n");

    // …and the control: the flag the module used before does follow it, which
    // is why the flag is the fix rather than the name.
    writeFileSync(leaf, "ACTIVATION-JSON\n");
    assert.equal(readFileSync(archive, "utf8"), "ACTIVATION-JSON\n", "the old flag follows the symlink");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
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

test("an artifact whose entrypoint climbs out of the release directory is refused", async () => {
  // The escape that the archive member filter cannot see: `entrypoint` is a
  // config field, not a member path, so it never passes through
  // `assertSafeMemberPath`. Unchecked, `join(staging, entrypoint)` resolves
  // outside the digest-named release directory and the runner is handed a path
  // the host never unpacked or verified.
  //
  // The target file is created first and — because `withRoots` awaits — is
  // still there when installation resumes, so the refusal cannot be the
  // "absent after unpack" check passing for the wrong reason. That distinction
  // is the whole value of this test: with the old `join`, the four `..`
  // segments climb staging → connectors → install root → base and land exactly
  // on `connector-artifacts/evil.mjs`, which exists, so the old code accepts
  // the escape and installs. The negative control therefore breaks behaviour,
  // not a string.
  const entrypoint = "../../../../connector-artifacts/evil.mjs";
  const fixture = buildFixture({ config: { entrypoint } });
  await withRoots(async (installRoot, durableRoot) => {
    mkdirSync(durableRoot, { recursive: true });
    const target = join(durableRoot, "evil.mjs");
    writeFileSync(target, "export const collectOura = () => {};\n");
    assert.ok(existsSync(target), "the escape target must exist for this to discriminate");

    // Pin the arithmetic the vulnerable `join` would do, so this test fails
    // loudly if the staging layout ever moves and the escape stops reaching a
    // real file — which would silently make the case non-discriminating again.
    const releaseDir = join(installRoot, "connectors", CONNECTOR_KEY, fixture.digest.replace(":", "-"));
    assert.equal(
      join(releaseDir, entrypoint),
      target,
      "the escape must resolve onto the staged target, or this test proves nothing"
    );

    // Either refusal is correct — the `..` rule and the realpath comparison are
    // independent gates on the same escape, and the test asserts the refusal,
    // not which gate got there first.
    await assert.rejects(
      obtain(fixture, installRoot, durableRoot),
      /entrypoint escapes the release directory|outside the release directory/
    );

    // Nothing was installed and the escape target was not consumed as code.
    assert.equal(existsSync(releaseDir), false, "a refused escape must not leave a release behind");
    assert.ok(existsSync(target), "the refusal must not have touched the file outside the store");
  });
});

test("an artifact declaring an absolute entrypoint is refused", async () => {
  // `join()` silently drops a leading separator, so an absolute entrypoint is
  // contained by accident rather than by a check. Refusing it by name means the
  // containment does not depend on that accident.
  //
  // The path is deliberately one the archive really unpacks, so the old `join`
  // strips the separator, lands on a file that exists, and *succeeds*. An
  // absolute path with no unpacked counterpart — `/etc/passwd`, say — would be
  // refused by the later "absent after unpack" check whether or not the
  // absolute-path rule existed, which would make this test agree with a
  // vulnerable implementation. Here, restoring `join` installs the release,
  // so the negative control fails on behaviour.
  const entrypoint = "/code/collection-profile.mjs";
  const fixture = buildFixture({ config: { entrypoint } });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /absolute entrypoint/);

    // The refusal must come before anything is published, not after.
    const releaseDir = join(installRoot, "connectors", CONNECTOR_KEY, fixture.digest.replace(":", "-"));
    assert.equal(existsSync(releaseDir), false, "a refused absolute entrypoint must not leave a release behind");
  });
});

test("an entrypoint that resolves outside the release through a symlink is refused", async () => {
  // The case no string rule catches. `escape/evil.mjs` is relative, has no
  // `..`, no backslash and no NUL; `join(release, entrypoint)` is a string
  // prefixed by `release`, so a prefix check passes it too. Only comparing
  // realpaths after resolution shows that it leaves the release directory —
  // which is why `assertContainedEntrypoint` resolves rather than compares
  // strings, for the same reason `assertRootsDisjoint` does.
  await withRoots((installRoot) => {
    const release = join(installRoot, "release");
    const outside = join(installRoot, "outside");
    mkdirSync(release, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "evil.mjs"), "//\n");
    symlinkSync(outside, join(release, "escape"));

    // The string-only checks this test exists to get past.
    const joined = join(release, "escape/evil.mjs");
    assert.ok(joined.startsWith(release), "a prefix check would accept this path");
    assert.equal(relative(release, joined).startsWith(".."), false, "a `..` check would accept this path");

    assert.throws(
      () => assertContainedEntrypoint(release, "escape/evil.mjs"),
      /resolves to .*outside the release directory/
    );

    // A genuinely contained entrypoint in the same release still resolves.
    mkdirSync(join(release, "code"), { recursive: true });
    writeFileSync(join(release, "code", "collection-profile.mjs"), "//\n");
    assert.equal(
      assertContainedEntrypoint(release, "code/collection-profile.mjs"),
      join(release, "code", "collection-profile.mjs")
    );
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

test("the install store and the durable root may not contain one another", async () => {
  await withRoots((installRoot, durableRoot) => {
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

// ---------------------------------------------------------------------------
// The store boundary: a pre-existing symlink under the install root must not
// relocate a release into the durable tree.
//
// `assertRootsDisjoint` proves the two *roots* are disjoint and stops there.
// These two cases are the ones that got past it: the roots stay exactly where
// they were declared, and a symlink *beneath* the install root moves the
// release anyway. Both require pre-existing local manipulation — neither is a
// remote signature bypass — but both falsify the separation the install store
// exists to provide, which is that removing installed code can never delete a
// collected archive.
// ---------------------------------------------------------------------------

/** The digest directory name for a fixture, as the store spells it. */
const releaseDirOf = (installRoot: string, digest: string): string =>
  join(installRoot, "connectors", CONNECTOR_KEY, digest.replace(":", "-"));

test("a release directory redirected into the durable tree is refused, not reused", async () => {
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    mkdirSync(join(installRoot, "connectors", CONNECTOR_KEY), { recursive: true });
    mkdirSync(join(durableRoot, "code"), { recursive: true });
    // A plausible-looking release, planted inside the durable tree.
    writeFileSync(join(durableRoot, "code", "collection-profile.mjs"), "export const collectOura = () => {};\n");
    symlinkSync(durableRoot, releaseDirOf(installRoot, fixture.digest));

    // Without the store-root check this is the cached-install branch: the
    // digest directory "exists", so the release is accepted and the entrypoint
    // handed back resolves inside durable data.
    await assert.rejects(
      obtain(fixture, installRoot, durableRoot),
      /outside the connector install store/
    );

    // The durable tree was neither executed from nor disturbed.
    assert.ok(existsSync(join(durableRoot, "code", "collection-profile.mjs")));
  });
});

test("a connector directory redirected into the durable tree cannot receive a fresh install", async () => {
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    // The durable root really exists, as it would on a host that has been
    // collecting: the redirection is a live symlink, not a dangling one.
    mkdirSync(durableRoot, { recursive: true });
    mkdirSync(join(installRoot, "connectors"), { recursive: true });
    symlinkSync(durableRoot, join(installRoot, "connectors", CONNECTOR_KEY));

    await assert.rejects(
      obtain(fixture, installRoot, durableRoot),
      /outside the connector install store/
    );

    // Nothing — staging or final — was written into the durable tree.
    assert.deepEqual(readdirSync(durableRoot), [], "a refused install must not write into durable data");
  });
});

test("a connector directory redirected through a not-yet-created target is still refused", async () => {
  // The dangling variant. `existsSync` follows symlinks, so it reports `false`
  // for a link whose target does not exist yet — a path walk that trusts it
  // steps straight past the link and treats the redirected component as an
  // ordinary directory still to be created. The refusal must come from the
  // store boundary, not from a later `ENOENT` that happens to stop the write.
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    mkdirSync(join(installRoot, "connectors"), { recursive: true });
    symlinkSync(durableRoot, join(installRoot, "connectors", CONNECTOR_KEY));
    assert.equal(existsSync(durableRoot), false, "this case is about a dangling link");

    await assert.rejects(
      obtain(fixture, installRoot, durableRoot),
      /outside the connector install store/
    );
  });
});

test("an install store reached through a symlinked root still installs normally", async () => {
  // The boundary is "does this resolve back inside the canonical store", not
  // "is a symlink involved anywhere". A deployment that reaches its store
  // through a symlinked parent is legitimate and must keep working, or the
  // check above would be enforced by breaking ordinary setups.
  const fixture = buildFixture();
  await withRoots(async (_unusedInstallRoot, durableRoot) => {
    const base = mkdtempSync(join(tmpdir(), "managed-connectors-linked-"));
    try {
      const realStore = join(base, "real-store");
      mkdirSync(realStore, { recursive: true });
      const linkedInstall = join(base, "install-link");
      symlinkSync(realStore, linkedInstall);

      const managed = await obtain(fixture, linkedInstall, durableRoot);
      const entry = managed[0];
      assert.ok(entry);
      assert.ok(
        realpathSync(entry.entrypoint).startsWith(realpathSync(realStore)),
        "the release must land inside the canonical store"
      );
      assert.match(readFileSync(entry.entrypoint, "utf8"), /collectOura/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The cached fast path: a digest in a directory name is not evidence that the
// directory's current contents still match that digest.
// ---------------------------------------------------------------------------

test("a cached release whose executable was modified is rebuilt from the verified layers", async () => {
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    const first = await obtain(fixture, installRoot, durableRoot);
    const entrypoint = first[0]?.entrypoint;
    assert.ok(entrypoint);

    // Tamper with installed code the way a local compromise would.
    writeFileSync(entrypoint, "export const collectOura = () => 'MODIFIED';\n");
    assert.match(readFileSync(entrypoint, "utf8"), /MODIFIED/, "the tamper must have landed");

    // Reinstalling the *same* verified artifact must not bless the edit.
    const second = await obtain(fixture, installRoot, durableRoot);
    const reinstalled = second[0]?.entrypoint;
    assert.ok(reinstalled);

    // Behaviour, not a string: import the path the manager hands the runner and
    // check which module body actually executes.
    const loaded = (await import(`${pathToFileURL(reinstalled).href}?case=modified`)) as {
      readonly collectOura: () => unknown;
    };
    assert.equal(loaded.collectOura(), undefined, "the returned path must execute the verified module");
    assert.doesNotMatch(readFileSync(reinstalled, "utf8"), /MODIFIED/);
  });
});

test("a cached release whose executable was deleted is rebuilt rather than returned missing", async () => {
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    const first = await obtain(fixture, installRoot, durableRoot);
    const entrypoint = first[0]?.entrypoint;
    assert.ok(entrypoint);
    rmSync(entrypoint, { force: true });
    assert.equal(existsSync(entrypoint), false, "the delete must have landed");

    const second = await obtain(fixture, installRoot, durableRoot);
    const reinstalled = second[0]?.entrypoint;
    assert.ok(reinstalled);
    assert.ok(existsSync(reinstalled), "a reinstall must never return a nonexistent entrypoint");
    assert.match(readFileSync(reinstalled, "utf8"), /collectOura/);
  });
});

test("reinstalling an untouched release is still a no-op, and connector scratch state survives", async () => {
  // The counterweight to the two tests above: content validation must not turn
  // every reinstall into a rewrite, and must not treat a connector's own
  // working files as tampering. Rewriting a release that is currently being
  // collected from is the thing the install/activate split exists to avoid.
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    const first = await obtain(fixture, installRoot, durableRoot);
    const directory = releaseDirOf(installRoot, fixture.digest);
    writeFileSync(join(directory, "scratch-state.json"), '{"cursor":1}\n');

    const second = await obtain(fixture, installRoot, durableRoot);
    assert.equal(first[0]?.entrypoint, second[0]?.entrypoint);
    assert.ok(existsSync(join(directory, "scratch-state.json")), "connector scratch state must survive a reinstall");
    assert.deepEqual(
      readdirSync(join(installRoot, "connectors", CONNECTOR_KEY)).filter((e) => e.includes(".invalid-")),
      [],
      "an untouched release must not be quarantined"
    );
  });
});

test("a quarantined release is moved aside, not deleted, so its bytes survive as evidence", async () => {
  // The invalid release is renamed rather than removed: the host has just found
  // modified code in a content-addressed store, and that is worth inspecting.
  // This test says only that, which is all the rename establishes — what a
  // repair costs a *running* collection is the test below, which drives a real
  // reader instead of checking that a directory exists.
  const fixture = buildFixture();
  await withRoots(async (installRoot, durableRoot) => {
    const first = await obtain(fixture, installRoot, durableRoot);
    const running = first[0]?.entrypoint;
    assert.ok(running);
    writeFileSync(running, "export const collectOura = () => 'MODIFIED';\n");

    await obtain(fixture, installRoot, durableRoot);

    const quarantined = readdirSync(join(installRoot, "connectors", CONNECTOR_KEY)).filter((e) =>
      e.includes(".invalid-")
    );
    assert.equal(quarantined.length, 1, "the invalid release must be kept aside as evidence");
    assert.ok(
      existsSync(join(installRoot, "connectors", CONNECTOR_KEY, quarantined[0]!, "code", "collection-profile.mjs")),
      "the quarantined copy must still hold the bytes that were found modified"
    );
  });
});

test("a repair does not preserve a running module's pathname reads, and the module says so", async () => {
  // The claim this replaces was that renaming an invalid release "leaves the
  // running process's open paths resolving to the quarantined directory". It
  // does not, and checking that a quarantined *directory exists* could never
  // have caught that — so this drives a real reader across a real repair.
  //
  // The connector's exported function resolves its sibling scratch file at CALL
  // time through `import.meta.url`, which is how a connector actually finds its
  // own working state. The function is imported and called BEFORE the repair,
  // then the SAME already-imported function is called after it.
  const fixture = buildFixture({
    codeEntries: [
      {
        path: "collection-profile.mjs",
        content:
          `import { readFileSync } from "node:fs";\n` +
          `import { fileURLToPath } from "node:url";\n` +
          `import { dirname, join } from "node:path";\n` +
          `const here = dirname(fileURLToPath(import.meta.url));\n` +
          `export const readScratch = () => readFileSync(join(here, "scratch-state.json"), "utf8").trim();\n`,
      },
    ],
  });

  await withRoots(async (installRoot, durableRoot) => {
    const first = await obtain(fixture, installRoot, durableRoot);
    const entrypoint = first[0]?.entrypoint;
    assert.ok(entrypoint);
    const releaseDir = releaseDirOf(installRoot, fixture.digest);

    // The running collection's own scratch state, beside its code.
    writeFileSync(join(releaseDir, "code", "scratch-state.json"), "RUN-STATE\n");
    const running = (await import(`${pathToFileURL(entrypoint).href}?case=active-run`)) as {
      readonly readScratch: () => string;
    };
    assert.equal(running.readScratch(), "RUN-STATE", "the reader must work before the repair");

    // Trigger a repair by modifying a file the installer wrote — not the
    // scratch file, which is legitimately extra and must not itself be a
    // mismatch.
    writeFileSync(join(releaseDir, "provenance.json"), `${JSON.stringify({ builder: "TAMPERED" }, null, 2)}\n`);
    const second = await obtain(fixture, installRoot, durableRoot);
    assert.equal(second[0]?.entrypoint, entrypoint, "the repaired release reoccupies the same canonical path");

    // Behaviour, not a string. The already-imported function still exists and
    // still runs — loaded module code survives a rename — but the path it
    // resolves now names the REPLACEMENT release, where its state is absent.
    assert.throws(
      () => running.readScratch(),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      "a repair must be understood to break the running collection's pathname reads, not claimed to preserve them"
    );

    // …and the state is recoverable only from the quarantine, which is exactly
    // what the module's warning now tells an operator.
    const quarantined = readdirSync(join(installRoot, "connectors", CONNECTOR_KEY)).filter((e) =>
      e.includes(".invalid-")
    );
    assert.equal(quarantined.length, 1);
    assert.equal(
      readFileSync(
        join(installRoot, "connectors", CONNECTOR_KEY, quarantined[0]!, "code", "scratch-state.json"),
        "utf8"
      ).trim(),
      "RUN-STATE",
      "the only surviving copy of the running collection's state is under the quarantine"
    );
  });
});

// ---------------------------------------------------------------------------
// Default signer policy.
// ---------------------------------------------------------------------------

test("the default signer policy accepts the publish workflow only on the reviewed ref", () => {
  // A digest pins which bytes; it does not establish that those bytes passed
  // through the reviewed publication authority. An expression that stops at
  // `…publish-polyfill-connectors.yml@` accepts the workflow running on any
  // branch or tag, so anyone able to push a branch can publish a modified copy
  // of the workflow and have it sign an artifact this host would accept.
  const pattern = PDP_CONNECT_CONNECTOR_IDENTITY.certificateIdentityPattern;
  const workflow = "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml";

  assert.equal(pattern.test(`${workflow}@refs/heads/main`), true, "the reviewed ref must still be accepted");

  for (const rejected of [
    `${workflow}@refs/heads/attacker-branch`,
    `${workflow}@refs/tags/v0.0.0-anything`,
    `${workflow}@refs/pull/1/merge`,
    "https://github.com/attacker/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main",
  ]) {
    assert.equal(pattern.test(rejected), false, `must not accept ${rejected}`);
  }
});

test("an artifact signed by the publish workflow on an unreviewed branch is refused end to end", async () => {
  // The policy test above is a string check on the pattern; this one drives the
  // real verification path so the constraint is proven where it is enforced.
  const fixture = buildFixture({
    signerIdentity:
      "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/attacker-branch",
  });
  await withRoots(async (installRoot, durableRoot) => {
    await assert.rejects(obtain(fixture, installRoot, durableRoot), /this host does not accept/);
  });
});
