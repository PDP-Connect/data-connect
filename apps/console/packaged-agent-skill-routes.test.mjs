// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CONSOLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CONSOLE_ROOT, "../..");
const STANDALONE_ROOT = path.join(CONSOLE_ROOT, ".next", "standalone");
const TEMP_ROOT = path.join(os.homedir(), ".tmp");
const SERVER_RELATIVE_PATHS = ["apps/console/server.js", "server.js"];
const STANDALONE_SERVER = SERVER_RELATIVE_PATHS.map((relativePath) => path.join(STANDALONE_ROOT, relativePath)).find(
  (serverPath) => existsSync(serverPath)
);
const SKILL_CATALOG_INDEX = /\/\.well-known\/skills\/index\.json/;
const MINIMUM_SKILL_REFERENCES = 7;

test("skill reference completeness detects a removed served file", () => {
  const ownerSkillPath = "pdpp-owner-agent/SKILL.md";
  const ownerMarkdown = readFileSync(path.join(REPO_ROOT, "docs/agent-skills", ownerSkillPath), "utf8");
  const references = extractRelativeFileReferences(ownerMarkdown);
  const servedPaths = new Set([
    "pdpp-owner-agent/SKILL.md",
    "pdpp-owner-agent/references/control-surface.md",
    "pdpp-owner-agent/references/daisy-runbook.md",
    "pdpp-owner-agent/references/sync.md",
  ]);
  servedPaths.delete("pdpp-owner-agent/references/daisy-runbook.md");
  assert.throws(() => assertSkillReferencesServed("pdpp-owner-agent", ownerSkillPath, references, servedPaths));
});

test("copied standalone console serves every advertised agent skill route outside the repository", {
  skip: !STANDALONE_SERVER && process.env.REQUIRE_STANDALONE !== "1" && "Run after the console standalone build",
}, async () => {
  assert.ok(STANDALONE_SERVER, "Build the console standalone server before this test");
  const createdTempRoot = !existsSync(TEMP_ROOT);
  mkdirSync(TEMP_ROOT, { recursive: true });
  const temporaryRoot = mkdtempSync(path.join(TEMP_ROOT, "agent-skill-standalone-"));
  const copiedStandaloneRoot = path.join(temporaryRoot, "standalone");
  const relativeServerPath = path.relative(STANDALONE_ROOT, STANDALONE_SERVER);
  const copiedServerPath = path.join(copiedStandaloneRoot, relativeServerPath);
  const serverDirectory = path.dirname(copiedServerPath);
  const output = { stderr: "", stdout: "" };
  let serverProcess;

  try {
    cpSync(STANDALONE_ROOT, copiedStandaloneRoot, { recursive: true });
    assert.equal(existsSync(path.join(copiedStandaloneRoot, "pnpm-workspace.yaml")), false);
    assert.equal(existsSync(path.join(copiedStandaloneRoot, "openspec")), false);

    const port = await findAvailablePort();
    serverProcess = spawn(process.execPath, [copiedServerPath], {
      cwd: serverDirectory,
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess.stdout.setEncoding("utf8").on("data", (chunk) => {
      output.stdout += chunk;
    });
    serverProcess.stderr.setEncoding("utf8").on("data", (chunk) => {
      output.stderr += chunk;
    });

    const origin = `http://127.0.0.1:${port}`;
    const response = await fetchWhenReady(`${origin}/.well-known/skills/index.json`, serverProcess, output);
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.equal(catalog.object, "agent_skill_catalog");
    assert.ok(Array.isArray(catalog.skills));

    const llmsIndex = await fetch(`${origin}/llms.txt`);
    assert.equal(llmsIndex.status, 200);
    assert.match(await llmsIndex.text(), SKILL_CATALOG_INDEX);

    const wellKnownLlmsIndex = await fetch(`${origin}/.well-known/llms.txt`);
    assert.equal(wellKnownLlmsIndex.status, 200);

    const fullText = await fetch(`${origin}/llms-full.txt`);
    assert.equal(fullText.status, 200);
    const fullTextBody = await fullText.text();

    const files = catalog.skills.flatMap((skill) => skill.files);
    const servedPaths = new Set(files.map((file) => file.path));
    await Promise.all(
      files.map(async (file) => {
        const fileResponse = await fetch(`${origin}/.well-known/skills/${file.path}`);
        assert.equal(fileResponse.status, 200, file.path);
        const body = Buffer.from(await fileResponse.arrayBuffer());
        assert.equal(body.byteLength, file.bytes, file.path);
        assert.equal(createHash("sha256").update(body).digest("hex"), file.sha256, file.path);
        assert.ok(fullTextBody.includes(body.toString("utf8")), `${file.path} is included in /llms-full.txt`);
      })
    );

    let extractedReferenceCount = 0;
    for (const skill of catalog.skills) {
      const skillFile = skill.files.find((file) => file.path === `${skill.name}/SKILL.md`);
      assert.ok(skillFile, `${skill.name} advertises its SKILL.md`);
      const response = await fetch(`${origin}/.well-known/skills/${skillFile.path}`);
      assert.equal(response.status, 200, skillFile.path);
      const markdown = await response.text();
      const references = extractRelativeFileReferences(markdown);
      assert.ok(references.length > 0, `${skill.name} has extracted relative file references`);
      extractedReferenceCount += references.length;
      assertSkillReferencesServed(skill.name, skillFile.path, references, servedPaths);
    }
    assert.ok(
      extractedReferenceCount >= MINIMUM_SKILL_REFERENCES,
      `extracts at least ${MINIMUM_SKILL_REFERENCES} known skill references (got ${extractedReferenceCount})`
    );
  } finally {
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill("SIGTERM");
      await waitForExit(serverProcess);
    }
    rmSync(temporaryRoot, { force: true, recursive: true });
    if (createdTempRoot) {
      rmdirSync(TEMP_ROOT);
    }
  }
});

function extractRelativeFileReferences(markdown) {
  const markdownLinks = [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(([, target]) => target.trim().replace(/^<|>$/g, ""));
  const codePaths = [...markdown.matchAll(/`([^`]+)`/g)]
    .map(([, target]) => target.trim())
    .filter((target) => /^(?:\.\/)?(?:references|docs|examples|schemas)\/[^\s]+/i.test(target));
  return [...new Set([...markdownLinks, ...codePaths])].filter(
    (target) => target && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)
  );
}

function assertSkillReferencesServed(skillName, skillFilePath, references, servedPaths) {
  for (const target of references) {
    const pathname = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? "");
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(skillFilePath), pathname));
    assert.ok(resolved.startsWith(`${skillName}/`), `${skillFilePath} link ${target} stays inside its skill`);
    assert.ok(servedPaths.has(resolved), `${skillFilePath} link ${target} resolves to a served file (${resolved})`);
  }
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function fetchWhenReady(url, serverProcess, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Standalone console exited early.\n${output.stdout}\n${output.stderr}`);
    }
    try {
      // The next probe depends on the server completing its previous startup attempt.
      // biome-ignore lint/performance/noAwaitInLoops: startup polling is intentionally sequential.
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Standalone console did not become ready.\n${output.stdout}\n${output.stderr}`);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 5000).unref();
  });
}
