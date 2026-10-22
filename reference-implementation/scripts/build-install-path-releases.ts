// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Package and push the two install-path releases, A and B, for journey J2-install.
 *
 * Both releases are built by data-connectors' own OCI builder, taken from the
 * revision the managed-connector pin names (`git show <sha>:<path>`), so this
 * never runs an unpinned copy. The builder packages only a connector that lives
 * in its own `packages/polyfill-connectors` tree. So the connector here lives in
 * a fixture tree with the same layout: the real builder, the real host-runtime
 * contract, the real LICENSE, NOTICE and package.json, and the install-path
 * manifest and connector.
 *
 * Release B differs from A only in one constant in the connector. Their code
 * layers differ, so their digests differ, while the manifest stays byte-identical.
 * Both are pushed under the same repository and version.
 *
 * Run from reference-implementation/:
 *
 *   node --import tsx scripts/build-install-path-releases.ts \
 *     --producer-git <data-connectors checkout> --producer-sha <40-hex> \
 *     --registry <host:port> --work <directory that does not exist> \
 *     --modules <directory whose node_modules/esbuild resolves> [--oras <path>]
 *
 * Prints {"repository", "a": {"digest"}, "b": {"digest"}} as JSON on stdout.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import {
  fixtureConnectorSource,
  INSTALL_PATH_PROFILE,
  INSTALL_PATH_REPOSITORY,
} from "../test/helpers/install-path-fixture.ts";

/** The files the builder and its gates read from the producer, at the pinned revision. */
const PRODUCER_FILES = [
  "scripts/build-connector-oci-artifact.mjs",
  "scripts/connector-host-runtime-contract.mjs",
  "LICENSE",
  "NOTICE",
  "packages/polyfill-connectors/package.json",
] as const;

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

function writeFixtureTree(root: string): void {
  for (const path of PRODUCER_FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), gitShow(path));
  }
  mkdirSync(join(root, "packages/polyfill-connectors/manifests"), { recursive: true });
  writeFileSync(
    join(root, "packages/polyfill-connectors/manifests/claude_code.json"),
    `${JSON.stringify(INSTALL_PATH_PROFILE, null, 2)}\n`
  );
  mkdirSync(join(root, "packages/polyfill-connectors/connectors/claude_code"), { recursive: true });
  writeFileSync(
    join(root, "packages/polyfill-connectors/connectors/claude_code/index.ts"),
    fixtureConnectorSource("release-a")
  );
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
    [join(root, "scripts/build-connector-oci-artifact.mjs"), "--connector", "claude_code", "--out", out],
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

mkdirSync(work, { recursive: true });
const fixtureRoot = join(work, "fixture");
mkdirSync(fixtureRoot);
writeFixtureTree(fixtureRoot);

const outA = join(work, "release-a");
const specA = build(fixtureRoot, outA);

writeFileSync(
  join(fixtureRoot, "packages/polyfill-connectors/connectors/claude_code/index.ts"),
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

process.stdout.write(
  `${JSON.stringify({ a: { digest: digestA }, b: { digest: digestB }, repository: INSTALL_PATH_REPOSITORY }, null, 2)}\n`
);
