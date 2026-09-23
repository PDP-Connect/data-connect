// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(read(relativePath)) as T;
}

test("Railway service configs build the current console and reference images", () => {
  const consoleConfig = readJson<{ build: { builder: string; dockerfilePath: string } }>(
    "deploy/railway/railway.console.json"
  );
  const referenceConfig = readJson<{ build: { builder: string; dockerfilePath: string } }>(
    "deploy/railway/railway.reference.json"
  );

  assert.equal(consoleConfig.build.builder, "DOCKERFILE");
  assert.equal(consoleConfig.build.dockerfilePath, "apps/console/Dockerfile");
  assert.equal(referenceConfig.build.builder, "DOCKERFILE");
  assert.equal(referenceConfig.build.dockerfilePath, "deploy/railway/reference.Dockerfile");
});

test("published Core uses the current public image and a single Core service", () => {
  const docs = `${read("deploy/railway/README.md")}\n${read("deploy/railway/template.md")}`;
  assert.match(docs, /ghcr\.io\/pdp-connect\/data-connect\/core:latest/);
  assert.match(docs, /one public Core app service/i);
  assert.doesNotMatch(docs, /ghcr\.io\/pdp-connect\/pdpp\//);
});

test("root image workflow validates all four Dockerfile targets without publishing", () => {
  const workflow = read(".github/workflows/docker-images.yml");
  const validate = workflow.split("  publish:")[0] ?? "";

  for (const target of ["reference", "console", "reference-browser", "core"]) {
    assert.match(validate, new RegExp(`target: ${target}\\n`));
  }
  assert.match(validate, /context: \./);
  assert.match(validate, /file: \.\/Dockerfile/);
  assert.match(validate, /push: false/);
});

test("the core image and Railway supervisor share the runtime layout", () => {
  const dockerfile = read("Dockerfile");
  const supervisor = read("deploy/railway/core-supervisor.ts");

  assert.match(dockerfile, /FROM browsers AS core/);
  assert.match(dockerfile, /COPY --from=source \/app \/app/);
  assert.match(dockerfile, /COPY --from=console-builder \/app\/apps\/console\/\.next\/standalone \/console/);
  assert.match(supervisor, /\/app\/reference-implementation\/server\/index\.ts/);
  assert.match(supervisor, /\/console\/apps\/console\/server\.js/);
});

test("the n.eko overlay builds the restored production browser image", () => {
  const compose = read("docker-compose.neko.yml");
  const dockerfile = read("docker/neko/Dockerfile");

  assert.match(compose, /dockerfile: docker\/neko\/Dockerfile/);
  assert.match(dockerfile, /ARG NEKO_BASE_IMAGE=/);
  assert.match(dockerfile, /install-patchright-chromium\.sh/);
  assert.match(read("docker/neko/start-neko.sh"), /exec/);
});

test("Railway upload context excludes machine-local agent directories", () => {
  const ignore = read(".railwayignore");
  for (const entry of ["skills", ".agents", ".claude", ".codex"]) {
    assert.match(ignore, new RegExp(`^${entry.replaceAll(".", "\\.")}$`, "m"));
  }
});
