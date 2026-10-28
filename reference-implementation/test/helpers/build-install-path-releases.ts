// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Package and push the two install-path releases, A and B, for journey J2-install.
 *
 * Both releases are built by data-connectors' own OCI builder, taken from the
 * revision the managed-connector pin names (`git show <sha>:<path>`), so this
 * never runs an unpinned copy. The builder reads a connector from
 * `connectors/<dir>/` at the repository root, and it reads every publishable
 * connector's manifest to compute the source declaration. So the connector here
 * lives in a fixture tree with the same layout: the real builder and the files
 * it imports or reads, the real host-runtime contract, the real LICENSE, NOTICE
 * and package.json, the manifests of the publishable connectors, and the
 * install-path manifest and connector.
 *
 * Release B differs from A only in one constant in the connector. Their code
 * layers differ, so their digests differ, while the manifest stays byte-identical.
 * Both are pushed under the same repository and version.
 *
 * The source declaration is the builder's own file. The publish workflow pushes it as an OCI referrer
 * of each release, not as an image layer, so an installer that reads only the layers it knows still
 * installs the release. This job does the same. Each release gets the declaration as a referrer, and
 * the referrer gets a signature stand-in of its own, because the installer checks the declaration's
 * signature before it trusts the bytes.
 *
 * Two more files go into the --work directory, and the journey reads them:
 *
 *  - `pins.json`: a shipped-shape `CollectionProfilePin` for each release. Its two
 *    sha256 values come from the built layers (the profile file, and the entrypoint
 *    inside the code layer), not from the installer. The journey therefore checks
 *    what the installer wrote against bytes this script produced.
 *  - A signature stand-in per release. The installer core refuses an artifact with
 *    no signature object before it calls the signature verifier, so each release
 *    gets a cosign-bundle-shaped referrer under the `sha256-<hex>` tag. Nothing
 *    signed it. The journey's verifier stub accepts it. It is not a Sigstore bundle.
 *
 * Run from reference-implementation/:
 *
 *   node --import tsx test/helpers/build-install-path-releases.ts \
 *     --producer-git <data-connectors checkout> --producer-sha <40-hex> \
 *     --registry <host:port> --work <directory that does not exist> \
 *     --modules <directory whose node_modules/esbuild resolves> [--oras <path>]
 *
 * Prints {"pins", "repository", "a": {"digest"}, "b": {"digest"}} as JSON on stdout.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { CollectionProfilePin } from "../../../packages/local-collector/src/managed/collection-profiles.ts";
import {
  fixtureConnectorSource,
  INSTALL_PATH_COLLECTOR_ID,
  INSTALL_PATH_CONNECTOR_KEY,
  INSTALL_PATH_PROFILE,
  INSTALL_PATH_REPOSITORY,
  INSTALL_PATH_VERSION,
} from "./install-path-fixture.ts";

/**
 * The files the builder reads from the producer, at the pinned revision. Derived from the builder's
 * import graph and its runtime reads at bd6f94a113:
 *
 *  - scripts/build-connector-oci-artifact.mjs imports connector-host-runtime-contract.mjs,
 *    source-declaration.mjs (which imports pdpp-source-contract.mjs) and
 *    source-declaration-members.mjs (which imports connector-publish-allowlist.mjs).
 *  - It reads packages/polyfill-connectors/package.json, LICENSE and NOTICE.
 *  - source-declaration-members.mjs reads the manifest of every publishable connector. See
 *    publishableManifests.
 */
const PRODUCER_FILES = [
  "scripts/build-connector-oci-artifact.mjs",
  "scripts/connector-host-runtime-contract.mjs",
  "scripts/connector-publish-allowlist.mjs",
  "scripts/source-declaration-members.mjs",
  "packages/connector-installer-core/pdpp-source-contract.mjs",
  "packages/connector-installer-core/source-declaration.mjs",
  "packages/polyfill-connectors/package.json",
  "LICENSE",
  "NOTICE",
] as const;

/** The producer's directory for the fixture connector: `connectors/<dir>`, and the builder's `--connector`. */
const CONNECTOR_DIRECTORY = "claude_code";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const IDENTITY = ["-c", "user.name=pdpp install-path journey", "-c", "user.email=install-path-journey@pdpp.invalid"];

interface LayerSpec {
  readonly artifactType: string;
  readonly config: { readonly file: string; readonly mediaType: string };
  readonly layers: readonly { readonly file: string; readonly mediaType: string }[];
}

const { values } = parseArgs({
  options: {
    modules: { type: "string" },
    oras: { default: "oras", type: "string" },
    "producer-git": { type: "string" },
    "producer-sha": { type: "string" },
    registry: { type: "string" },
    work: { type: "string" },
  },
  strict: true,
});

function required(name: "modules" | "producer-git" | "producer-sha" | "registry" | "work"): string {
  const value = values[name];
  if (value === undefined || value === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

const producerGit = required("producer-git");
const producerSha = required("producer-sha");
const registry = required("registry");
const work = required("work");
const modules = required("modules");
const oras = values.oras ?? "oras";

if (!/^[0-9a-f]{40}$/.test(producerSha)) {
  throw new Error(`--producer-sha must be a full 40-hex commit, got ${producerSha}`);
}
if (!/^[A-Za-z0-9.-]+:\d+$/.test(registry)) {
  throw new Error(`--registry must be host:port, got ${registry}`);
}
if (existsSync(work)) {
  throw new Error(`--work ${work} already exists; pass a new directory`);
}

function gitShow(path: string): Buffer {
  return execFileSync("git", ["-C", producerGit, "show", `${producerSha}:${path}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function commit(root: string, message: string): void {
  git(root, [...IDENTITY, "commit", "-q", "--allow-empty-message", "-m", message]);
}

/**
 * The manifest names of every publishable connector, read from the publish inventory the builder
 * imports. source-declaration-members.mjs reads each of these manifests while it computes a
 * source's members, before it filters them, so the fixture tree must hold all of them.
 */
function publishableManifests(root: string): string[] {
  const inventory = pathToFileURL(join(root, "scripts/connector-publish-allowlist.mjs")).href;
  const script = [
    `const { PUBLISHABLE_CONNECTORS } = await import(${JSON.stringify(inventory)});`,
    "process.stdout.write(JSON.stringify(PUBLISHABLE_CONNECTORS.map(({ manifest }) => manifest)));",
  ].join("\n");
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
  ) as string[];
}

function writeFixtureTree(root: string): void {
  for (const path of PRODUCER_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), gitShow(path));
  }
  for (const manifest of publishableManifests(root)) {
    // The install-path profile below replaces this connector's producer manifest.
    if (manifest === CONNECTOR_DIRECTORY) {
      continue;
    }
    mkdirSync(join(root, "connectors", manifest), { recursive: true });
    writeFileSync(
      join(root, "connectors", manifest, "manifest.json"),
      gitShow(`connectors/${manifest}/manifest.json`)
    );
  }
  mkdirSync(join(root, "connectors", CONNECTOR_DIRECTORY), { recursive: true });
  writeFileSync(
    join(root, "connectors", CONNECTOR_DIRECTORY, "manifest.json"),
    `${JSON.stringify(INSTALL_PATH_PROFILE, null, 2)}\n`
  );
  writeFileSync(join(root, "connectors", CONNECTOR_DIRECTORY, "index.ts"), fixtureConnectorSource("release-a"));
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  // The builder imports esbuild from scripts/, so node_modules must resolve it.
  symlinkSync(modules, join(root, "node_modules"), "dir");
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  commit(root, "fixture: install-path release A");
}

function build(root: string, out: string): LayerSpec {
  execFileSync(
    process.execPath,
    [join(root, "scripts/build-connector-oci-artifact.mjs"), "--connector", CONNECTOR_DIRECTORY, "--out", out],
    {
      cwd: root,
      // The builder logs to stdout. Stdout here carries only the digests, so the builder's log goes to stderr.
      stdio: ["ignore", 2, 2],
    }
  );
  return JSON.parse(readFileSync(join(out, "layers.json"), "utf8")) as LayerSpec;
}

function push(out: string, spec: LayerSpec, tag: string): string {
  const reference = `${registry}/${INSTALL_PATH_REPOSITORY}:${tag}`;
  const stdout = execFileSync(
    oras,
    [
      "push",
      "--plain-http",
      reference,
      "--artifact-type",
      spec.artifactType,
      "--config",
      `${spec.config.file}:${spec.config.mediaType}`,
      "--format",
      "json",
      ...spec.layers.map((layer) => `${layer.file}:${layer.mediaType}`),
    ],
    { cwd: out, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  // The digest the registry stored, read from oras's own output. Recomputing it here would
  // check this script's arithmetic against itself.
  const { digest } = JSON.parse(stdout) as { digest?: unknown };
  if (typeof digest !== "string" || !DIGEST.test(digest)) {
    throw new Error(`oras push ${reference} did not report a usable digest: ${JSON.stringify(digest)}`);
  }
  return digest;
}

const BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";

function sha256Digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The two sha256 values a pin records, read from one built release: the profile
 * file, and the entrypoint inside the code tarball. The member is named as the
 * artifact's config.entrypoint names it, relative to the code layer.
 */
function pinHashes(
  out: string,
): Pick<CollectionProfilePin, "entrypointSha256" | "profileSha256"> {
  const profile = readFileSync(join(out, "collection-profile.json"));
  const entrypoint = execFileSync(
    "tar",
    ["-xzOf", join(out, "code.tar.gz"), "collection-profile.mjs"],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return {
    entrypointSha256: sha256Digest(entrypoint),
    profileSha256: sha256Digest(profile),
  };
}

/**
 * The signature stand-in. Shaped as cosign v3 writes a bundle, with the one part
 * the installer reads before it calls the verifier: the DSSE payload, an in-toto
 * statement whose subject names the release digest. The signature and the
 * verification material are empty. Nothing signed this.
 */
function fabricatedBundle(digest: string): string {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {},
    predicateType: "https://cosign.sigstore.dev/attestation/v1",
    subject: [
      {
        digest: { sha256: digest.slice("sha256:".length) },
        name: `ghcr.io/${INSTALL_PATH_REPOSITORY}`,
      },
    ],
  };
  return `${JSON.stringify(
    {
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ keyid: "", sig: "" }],
      },
      mediaType: BUNDLE_MEDIA_TYPE,
      verificationMaterial: {},
    },
    null,
    2,
  )}\n`;
}

/** Attach the signature stand-in to a pushed artifact, by digest, under the referrers tag the installer reads. */
function attachSignature(out: string, digest: string): void {
  writeFileSync(join(out, "signature.bundle.json"), fabricatedBundle(digest));
  execFileSync(
    oras,
    [
      "attach",
      "--plain-http",
      "--distribution-spec",
      "v1.1-referrers-tag",
      "--artifact-type",
      BUNDLE_MEDIA_TYPE,
      `${registry}/${INSTALL_PATH_REPOSITORY}@${digest}`,
      `signature.bundle.json:${BUNDLE_MEDIA_TYPE}`,
    ],
    { cwd: out, stdio: ["ignore", 2, 2] },
  );
}

const SOURCE_DECLARATION_MEDIA_TYPE = "application/vnd.pdpp.connector.source-declaration.v1+json";

/**
 * Attach the source declaration to a pushed release as an OCI referrer, with the same `oras attach` the
 * publish workflow runs, then sign that referrer. The installer checks the referrer's own signature before
 * it accepts the declaration, so the referrer gets a stand-in of its own.
 */
function attachSourceDeclaration(out: string, digest: string): void {
  const stdout = execFileSync(
    oras,
    [
      "attach",
      "--plain-http",
      "--artifact-type",
      SOURCE_DECLARATION_MEDIA_TYPE,
      "--format",
      "json",
      `${registry}/${INSTALL_PATH_REPOSITORY}@${digest}`,
      `source-declaration.json:${SOURCE_DECLARATION_MEDIA_TYPE}`,
    ],
    { cwd: out, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  // The referrer's manifest digest, from oras's own output. The installer looks this digest up, and the
  // signature covers it.
  const { digest: referrerDigest } = JSON.parse(stdout) as { digest?: unknown };
  if (typeof referrerDigest !== "string" || !DIGEST.test(referrerDigest)) {
    throw new Error(
      `oras attach of the source declaration to ${digest} did not report a usable digest: ${JSON.stringify(referrerDigest)}`
    );
  }
  attachSignature(out, referrerDigest);
}

function pinFor(digest: string, out: string): CollectionProfilePin {
  return {
    connectorId: INSTALL_PATH_COLLECTOR_ID,
    connectorKey: INSTALL_PATH_CONNECTOR_KEY,
    digest,
    version: INSTALL_PATH_VERSION,
    ...pinHashes(out),
  };
}

mkdirSync(work, { recursive: true });
const fixtureRoot = join(work, "fixture");
mkdirSync(fixtureRoot);
writeFixtureTree(fixtureRoot);

const outA = join(work, "release-a");
const specA = build(fixtureRoot, outA);

writeFileSync(
  join(fixtureRoot, "connectors", CONNECTOR_DIRECTORY, "index.ts"),
  fixtureConnectorSource("release-b")
);
git(fixtureRoot, ["add", "-A"]);
commit(fixtureRoot, "fixture: install-path release B (one build constant changed)");

const outB = join(work, "release-b");
const specB = build(fixtureRoot, outB);

const digestA = push(outA, specA, "journey-a");
const digestB = push(outB, specB, "journey-b");
if (digestA === digestB) {
  throw new Error(
    "releases A and B pushed with the same digest; the install-path journey needs two different artifacts"
  );
}

attachSignature(outA, digestA);
attachSignature(outB, digestB);
attachSourceDeclaration(outA, digestA);
attachSourceDeclaration(outB, digestB);
const pinsPath = join(work, "pins.json");
writeFileSync(
  pinsPath,
  `${JSON.stringify({ a: pinFor(digestA, outA), b: pinFor(digestB, outB) }, null, 2)}\n`,
);

process.stdout.write(
  `${JSON.stringify({ a: { digest: digestA }, b: { digest: digestB }, pins: pinsPath, repository: INSTALL_PATH_REPOSITORY }, null, 2)}\n`,
);
