// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { TrustedWorkerArtifact } from "./connector-worker-resource.ts";

const require = createRequire(import.meta.url);
// Use the installed, locked tsx compiler, without installing another toolchain.
const compilerPath = require.resolve("esbuild", { paths: [require.resolve("tsx")] });
const compiler = require(compilerPath) as {
  buildSync: (options: Record<string, unknown>) => {
    warnings: readonly unknown[];
    metafile?: {
      inputs: Record<
        string,
        { imports: readonly { path: string; original?: string; kind: string; external?: boolean }[] }
      >;
    };
    outputFiles?: readonly { contents: Uint8Array }[];
  };
};
const DIGEST = /^[a-f0-9]{64}$/;
const CODE_PATH = /^code\/[a-zA-Z0-9_./-]+\.mjs$/;
const SHA_PREFIX = /^sha256:/;
const BASE_ARG = /ARG NODE_VERSION=(\S+)/;
const APPROVED_BASE = "24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const NODE_PATH = "/usr/local/bin/node";
const ROOT = "/worker/code";
const BOOTSTRAP = "/worker/bootstrap.mjs";
const PREFIX = "dev.pdpp.worker.";

/** Trusted output of verification, not a filesystem path or a claim of signing. */
export interface VerifiedWorkerSnapshot {
  readonly artifactDigest: string;
  readonly entrypoint: string;
  readonly files: readonly { readonly path: string; readonly bytes: Buffer; readonly sha256: string }[];
}

/** Parse one verified module into edges inside the verified snapshot; never resolve host files. */
function staticModuleDependencies(
  file: { readonly path: string; readonly bytes: Buffer },
  paths: ReadonlySet<string>
): string[] {
  const parsed = compiler.buildSync({
    bundle: true,
    external: ["*"],
    format: "esm",
    logLevel: "silent",
    logOverride: { "unsupported-dynamic-import": "warning" },
    metafile: true,
    platform: "neutral",
    stdin: { contents: file.bytes.toString("utf8"), loader: "js", sourcefile: file.path },
    write: false,
  });
  const input = parsed.metafile?.inputs[file.path];
  if (!input || parsed.warnings.length) {
    throw new Error("Unsupported dependency closure");
  }
  const dependencies: string[] = [];
  for (const imported of input.imports) {
    if (
      imported.kind !== "import-statement" ||
      !imported.external ||
      !(imported.path.startsWith("./") || imported.path.startsWith("../")) ||
      !imported.path.endsWith(".mjs")
    ) {
      throw new Error("Unsupported dependency closure");
    }
    const resolved = posix.normalize(posix.join(posix.dirname(file.path), imported.path));
    if (!(resolved.startsWith("code/") && paths.has(resolved))) {
      throw new Error("Unsupported dependency closure");
    }
    dependencies.push(resolved);
  }
  return dependencies;
}

export function captureWorkerSnapshot(snapshot: VerifiedWorkerSnapshot) {
  if (!DIGEST.test(snapshot.artifactDigest) || snapshot.files.length === 0) {
    throw new Error("Invalid verified module snapshot");
  }
  const files = snapshot.files.map((file) => {
    if (!CODE_PATH.test(file.path) || posix.normalize(file.path) !== file.path) {
      throw new Error("Invalid snapshot path");
    }
    const bytes = Buffer.from(file.bytes);
    if (bytes.length > 1024 * 1024 || hash(bytes) !== file.sha256.replace(SHA_PREFIX, "")) {
      throw new Error("Snapshot byte mismatch");
    }
    return { bytes, imagePath: `/worker/${file.path}`, path: file.path, sha256: hash(bytes) };
  });
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length || !paths.has(snapshot.entrypoint)) {
    throw new Error("Snapshot entrypoint or member mismatch");
  }

  // Parse only verified in-memory bytes. Keep every import external so esbuild
  // cannot resolve or read an outside path; resolve static specifiers lexically.
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const dependencies = staticModuleDependencies(file, paths);
    graph.set(file.path, dependencies);
  }
  const reachable = new Set<string>();
  const pending = [snapshot.entrypoint];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path && !reachable.has(path)) {
      reachable.add(path);
      pending.push(...(graph.get(path) ?? []));
    }
  }
  if (reachable.size !== files.length) {
    throw new Error("Unsupported dependency closure");
  }
  return { artifactDigest: snapshot.artifactDigest, entrypoint: snapshot.entrypoint, files };
}

export interface WorkerImageReceipt {
  readonly artifact: TrustedWorkerArtifact;
  readonly base: string;
  readonly buildId: string;
  readonly compiler: { readonly version: string; readonly sha256: string; readonly binarySha256: string };
  readonly files: readonly { readonly imagePath: string; readonly sha256: string; readonly size: number }[];
  readonly imageConfig: unknown;
  readonly imageSize: number;
  readonly nodeSha256: string;
  readonly schema: 1;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly sourceHead: string;
  readonly tag: string;
}

/** Calls only the fixed local socket; ambient redirects are refused, not ignored. */
export function localWorkerDocker(log: (args: readonly string[], output: string) => void) {
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) {
    throw new Error("Ambient Docker redirect refused");
  }
  const run = (args: readonly string[]) => {
    const config = mkdtempSync(join(homedir(), ".tmp/worker-docker-"));
    log(args, "dispatch");
    try {
      const output = execFileSync("/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", ...args], {
        env: { DOCKER_CONFIG: config, HOME: config, PATH: "/usr/bin:/bin" },
        maxBuffer: 128 * 1024 * 1024,
        timeout: 180_000,
      });
      log(args, args[0] === "cp" ? `[tar bytes: ${output.length}]` : output.toString());
      return output;
    } finally {
      rmSync(config, { force: true, recursive: true });
    }
  };
  const version = JSON.parse(run(["version", "--format", "{{json .Server}}"]).toString()) as { Os: string };
  assert.equal(version.Os, "linux");
  return run;
}

type Docker = ReturnType<typeof localWorkerDocker>;
function inspect(docker: Docker, imageId: string) {
  return JSON.parse(docker(["image", "inspect", imageId]).toString())[0] as {
    Id: string;
    Config: Record<string, unknown>;
    Size: number;
  };
}

function extract(docker: Docker, imageId: string, paths: readonly string[], buildId: string) {
  const id = docker([
    "create",
    "--label",
    `${PREFIX}extraction=${buildId}`,
    "--network",
    "none",
    "--read-only",
    "--user",
    "65532:65532",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    imageId,
  ])
    .toString()
    .trim();
  try {
    return paths.map((path) => {
      const archive = docker(["cp", `${id}:${path}`, "-"]);
      return execFileSync("/usr/bin/tar", ["-xOf", "-"], { input: archive, maxBuffer: 128 * 1024 * 1024 });
    });
  } finally {
    docker(["rm", id]);
  }
}

/** Receipt is trusted local build output; comparison does not authenticate arbitrary JSON. */
export function verifyWorkerImage(docker: Docker, receipt: WorkerImageReceipt): void {
  const actual = inspect(docker, receipt.artifact.imageId);
  assert.equal(actual.Id, receipt.artifact.imageId);
  assert.deepEqual(actual.Config, receipt.imageConfig);
  const labels = actual.Config.Labels as Record<string, string>;
  assert.equal(labels[`${PREFIX}artifact`], receipt.artifact.artifactDigest);
  assert.equal(labels[`${PREFIX}bootstrap`], receipt.artifact.bootstrapDigest);
  for (const field of ["Env", "Volumes", "ExposedPorts", "OnBuild"]) {
    const value = actual.Config[field];
    assert.ok(
      value === null ||
        value === undefined ||
        JSON.stringify(value) === "[]" ||
        JSON.stringify(value) === "{}" ||
        (field === "Env" &&
          JSON.stringify(value) ===
            JSON.stringify(["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]))
    );
  }
  const bytes = extract(
    docker,
    actual.Id,
    [NODE_PATH, ...receipt.files.map((file) => file.imagePath)],
    receipt.buildId
  );
  assert.equal(hash(bytes[0] ?? Buffer.alloc(0)), receipt.nodeSha256);
  for (const [index, file] of receipt.files.entries()) {
    const content = bytes[index + 1];
    assert.ok(content);
    assert.equal(content.length, file.size);
    assert.equal(hash(content), file.sha256);
  }
  assert.equal(receipt.artifact.nodePath, NODE_PATH);
  assert.equal(receipt.artifact.bootstrapPath, BOOTSTRAP);
  assert.equal(receipt.artifact.executionRoot, ROOT);
  assert.ok(receipt.artifact.connectorEntry.startsWith(`${ROOT}/`));
  assert.ok(receipt.files.some((file) => file.imagePath === receipt.artifact.connectorEntry));
  assert.ok(
    receipt.files.some((file) => file.imagePath === BOOTSTRAP && file.sha256 === receipt.artifact.bootstrapDigest)
  );
}

/** Caller owns the returned image/tag until exact removal; no publication or activation. */
export function buildWorkerImage(options: {
  readonly repo: string;
  readonly scratchParent: string;
  readonly snapshot: VerifiedWorkerSnapshot;
  readonly log: (args: readonly string[], output: string) => void;
}): WorkerImageReceipt {
  const snapshot = captureWorkerSnapshot(options.snapshot);
  const docker = localWorkerDocker(options.log); // validate endpoint before mutation
  const buildId = randomUUID();
  const tag = `pdpp-worker-r116:${buildId}`;
  const inputs = [
    "deploy/docker/Dockerfile",
    "deploy/railway/reference.Dockerfile",
    "deploy/docker/connector-worker.Dockerfile",
    "reference-implementation/runtime/connector-worker-entry.ts",
    "reference-implementation/server/worker-image-builder.ts",
    "package-lock.json",
  ];
  const sourceHashes = Object.fromEntries(inputs.map((path) => [path, hash(readFileSync(join(options.repo, path)))]));
  const pins = inputs.slice(0, 2).map((path) => BASE_ARG.exec(readFileSync(join(options.repo, path), "utf8"))?.[1]);
  assert.equal(pins[0], pins[1]);
  assert.equal(pins[0], APPROVED_BASE);
  const base = `node:${pins[0]}`;
  const bootstrap = compiler.buildSync({
    bundle: true,
    entryPoints: [join(options.repo, inputs[3] ?? "")],
    format: "esm",
    logLevel: "silent",
    platform: "node",
    target: "node24",
    write: false,
  }).outputFiles?.[0]?.contents;
  assert.ok(bootstrap);
  const bootstrapBytes = Buffer.from(bootstrap);
  const context = mkdtempSync(join(options.scratchParent, "worker-image-"));
  let built = false;
  try {
    writeFileSync(
      join(context, ".fleet-owner.json"),
      JSON.stringify({ disposable: true, thread_id: "r116", tim_driven: false })
    );
    mkdirSync(join(context, "code"));
    for (const file of snapshot.files) {
      const target = join(context, file.path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, file.bytes, { mode: 0o444 });
    }
    writeFileSync(join(context, "bootstrap.mjs"), bootstrapBytes);
    writeFileSync(join(context, "Dockerfile"), readFileSync(join(options.repo, inputs[2] ?? "")));
    docker([
      "build",
      "--network=none",
      "--build-arg",
      `NODE_BASE=${base}`,
      "--label",
      `${PREFIX}artifact=${snapshot.artifactDigest}`,
      "--label",
      `${PREFIX}bootstrap=${hash(bootstrapBytes)}`,
      "--tag",
      tag,
      context,
    ]);
    built = true;
    const image = inspect(docker, tag);
    const artifact: TrustedWorkerArtifact = {
      allowedEnvironmentNames: [],
      artifactDigest: snapshot.artifactDigest,
      bootstrapDigest: hash(bootstrapBytes),
      bootstrapPath: BOOTSTRAP,
      connectorEntry: `/worker/${snapshot.entrypoint}`,
      executionRoot: ROOT,
      imageId: image.Id,
      nodePath: NODE_PATH,
    };
    const [nodeBytes] = extract(docker, image.Id, [NODE_PATH], buildId);
    const [baseNodeBytes] = extract(docker, base, [NODE_PATH], buildId);
    assert.deepEqual(nodeBytes, baseNodeBytes);
    assert.ok(nodeBytes);
    const receipt: WorkerImageReceipt = {
      artifact,
      base,
      buildId,
      compiler: {
        binarySha256: hash(readFileSync(require.resolve("@esbuild/linux-x64/bin/esbuild", { paths: [compilerPath] }))),
        sha256: hash(readFileSync(compilerPath)),
        version: (require(compilerPath) as { version: string }).version,
      },
      files: [
        { imagePath: BOOTSTRAP, sha256: hash(bootstrapBytes), size: bootstrapBytes.length },
        ...snapshot.files.map((file) => ({ imagePath: file.imagePath, sha256: file.sha256, size: file.bytes.length })),
      ],
      imageConfig: image.Config,
      imageSize: image.Size,
      nodeSha256: hash(nodeBytes),
      schema: 1,
      sourceHashes,
      sourceHead: execFileSync("git", ["-C", options.repo, "rev-parse", "HEAD"]).toString().trim(),
      tag,
    };
    verifyWorkerImage(docker, receipt);
    return receipt;
  } catch (error) {
    if (built) {
      docker(["image", "rm", tag]);
    }
    throw error;
  } finally {
    rmSync(context, { force: true, recursive: true });
  }
}
