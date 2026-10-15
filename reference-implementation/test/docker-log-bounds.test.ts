// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every shipped Compose launch must resolve to bounded Docker logs. This
 * checks the EFFECTIVE configuration (`docker compose config`, which needs the
 * CLI but not a running daemon) for each file/overlay/profile combination an
 * operator or smoke script uses, so a new service or overlay that drops the
 * policy fails here instead of growing an unrotated log on a host.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const README_DOCKER_RUN = /```sh\n(?:export [^\n]*\n)?(docker run -d --name pdpp[\s\S]*?)\n```/gu;
const LINE_CONTINUATION = /\\\n/gu;
const README_LOG_FLAGS = /--log-driver json-file --log-opt max-size=10m --log-opt max-file=5 /u;
const BOUNDED = { driver: "json-file", options: { "max-file": "5", "max-size": "10m" } };

interface Launch {
  readonly args: readonly string[];
  readonly name: string;
  readonly services: readonly string[];
}

const LAUNCHES: readonly Launch[] = [
  { args: ["-f", "docker-compose.yml"], name: "root", services: ["postgres", "reference", "web"] },
  {
    args: ["-f", "docker-compose.yml", "-f", "docker-compose.dev.yml"],
    name: "root + dev overlay",
    services: ["postgres", "reference", "web"],
  },
  {
    args: ["-f", "docker-compose.yml", "-f", "docker-compose.neko.yml"],
    name: "root + neko overlay",
    services: ["neko", "postgres", "reference", "registry-mock", "web"],
  },
  {
    args: [
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.neko.yml",
      "-f",
      "docker-compose.dev.yml",
      "--profile",
      "neko-dynamic",
      "--profile",
      "turn",
    ],
    name: "root + neko + dev, all profiles",
    services: ["coturn", "neko", "neko-allocator", "postgres", "reference", "registry-mock", "web"],
  },
  { args: ["-f", "deploy/docker/docker-compose.yml"], name: "deploy/docker", services: ["core", "postgres"] },
];

function effectiveServices(args: readonly string[]): Record<string, { logging?: unknown }> {
  const result = spawnSync("docker", ["compose", ...args, "config", "--format", "json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // Placeholder for the one `:?`-required variable; config only interpolates.
    env: { ...process.env, DOCKER_HOST: "unix:///nonexistent.sock", PDPP_CREDENTIAL_ENCRYPTION_KEY: "placeholder" },
  });
  assert.equal(result.status, 0, `docker compose config failed: ${result.stderr}`);
  return (JSON.parse(result.stdout) as { services: Record<string, { logging?: unknown }> }).services;
}

for (const launch of LAUNCHES) {
  test(`compose launch "${launch.name}" resolves to bounded json-file logs on every service`, () => {
    const services = effectiveServices(launch.args);
    assert.deepEqual(Object.keys(services).sort(), [...launch.services].sort(), "service inventory changed");
    for (const [name, service] of Object.entries(services)) {
      assert.deepEqual(service.logging, BOUNDED, `${name} must have the bounded log policy`);
    }
  });
}

test("every README `docker run` block bounds logs before the image", async () => {
  const readme = await readFile(resolve(REPO_ROOT, "deploy/docker/README.md"), "utf8");
  const commands = [...readme.matchAll(README_DOCKER_RUN)].map((match) =>
    (match[1] ?? "").replace(LINE_CONTINUATION, " ")
  );
  assert.equal(commands.length, 2, "README docker run block count changed; classify the new launch");
  for (const command of commands) {
    const flags = command.split("ghcr.io/")[0] ?? "";
    assert.match(flags, README_LOG_FLAGS);
  }
});

// --- Direct `docker run` launches (scripts, CI, test helpers). Each file lists
// --- every launch it owns; a launch with no log flag, or a new unlisted launch
// --- site, fails.

const BACKUP_HELPER_LAUNCH = /\["run",[^\]]*\]/gu;
const BACKUP_HELPER_RUN = /"run", "--rm", "--log-driver", "none"/u;
const HOSTED_INGEST_LAUNCH = /runDocker\(\[\s*"run",[\s\S]*?dockerImage\(\)/u;
const HOSTED_INGEST_BOUNDED = /runDocker\(\[\s*"run",[\s\S]*?\.\.\.BOUNDED_LOG_RUN_ARGS,[\s\S]*?dockerImage\(\)/u;
const byName = (a: string, b: string) => a.localeCompare(b);
const NONE = "--log-driver none";
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal shell array expansion is the text under test.
const BOUND_ARRAY = '"${LOG_BOUND[@]}"';
const BOUND_ARRAY_DEFINITION = "LOG_BOUND=(--log-driver json-file --log-opt max-size=10m --log-opt max-file=5)";

/** file -> the log flag each `docker run` in it must carry, in source order. */
const SHELL_LAUNCHES: Readonly<Record<string, readonly string[]>> = {
  ".github/workflows/docker-images.yml": [NONE, NONE],
  ".github/workflows/release.yml": [NONE, NONE],
  "scripts/core-headed-patchright-runtime-oracle.sh": [NONE, NONE],
  "scripts/docker-bootstrap-readiness-oracle.sh": [BOUND_ARRAY, BOUND_ARRAY, BOUND_ARRAY],
  "scripts/docker-core-demo-smoke.sh": [BOUND_ARRAY, NONE],
  "scripts/docker-neko-network-migration-smoke.sh": [NONE],
  "scripts/published-compose-bootstrap-smoke.sh": [NONE],
};
const SHELL_DOCKER_RUN = /\bdocker run\b/u;
const TS_DOCKER_RUN = /(?:execFileSync\("docker", \[|runDocker\(\[\s*)"run"/mu;
const COMMENT_LINE = /^\s*(?:#|\/\/|\*)/u;

function sourceFiles(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(join(REPO_ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)))
    .map((entry) => relative(REPO_ROOT, join(entry.parentPath, entry.name)));
}

/** Non-comment logical lines (backslash continuations joined) that start a launch. */
function launchStatements(file: string, pattern: RegExp): string[] {
  const joined = readFileSync(join(REPO_ROOT, file), "utf8").replace(/\\\n/gu, " ");
  return joined.split("\n").filter((line) => !COMMENT_LINE.test(line) && pattern.test(line));
}

function launchesDockerRunFromTs(file: string): boolean {
  const code = readFileSync(join(REPO_ROOT, file), "utf8")
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n");
  return TS_DOCKER_RUN.test(code);
}

for (const [file, flags] of Object.entries(SHELL_LAUNCHES)) {
  test(`${file}: every docker run carries its explicit log flag`, () => {
    const statements = launchStatements(file, SHELL_DOCKER_RUN);
    assert.equal(statements.length, flags.length, "docker run launch count changed; classify the new launch");
    statements.forEach((statement, index) => {
      assert.ok(statement.includes(flags[index] as string), `launch ${index + 1} lacks ${flags[index]}: ${statement}`);
    });
  });
}

test("the shared shell LOG_BOUND array is the exact bounded json-file policy", () => {
  for (const file of ["scripts/docker-bootstrap-readiness-oracle.sh", "scripts/docker-core-demo-smoke.sh"]) {
    assert.ok(readFileSync(join(REPO_ROOT, file), "utf8").includes(BOUND_ARRAY_DEFINITION), file);
  }
});

test("no unclassified docker run launch exists in scripts, workflows or test helpers", () => {
  const found = [...sourceFiles("scripts", [".sh", ".mjs", ".ts"]), ...sourceFiles(".github/workflows", [".yml"])]
    .filter((file) => !(file.includes(".test.") || file.includes("fixtures")))
    .filter((file) => launchStatements(file, SHELL_DOCKER_RUN).length > 0);
  assert.deepEqual(found.sort(byName), Object.keys(SHELL_LAUNCHES).sort(byName));

  const tsFound = [
    ...sourceFiles("reference-implementation/scripts", [".ts"]),
    ...sourceFiles("reference-implementation/test", [".ts"]),
  ]
    .filter(launchesDockerRunFromTs)
    .sort(byName);
  assert.deepEqual(tsFound, [
    "reference-implementation/scripts/hosted-ingest-memory-cgroup.ts",
    "reference-implementation/test/backup-table-inventory-postgres.test.ts",
  ]);
});

test("backup-table-inventory test helper runs every client container with --log-driver none", () => {
  const source = readFileSync(
    join(REPO_ROOT, "reference-implementation/test/backup-table-inventory-postgres.test.ts"),
    "utf8"
  );
  const launches = source.match(BACKUP_HELPER_LAUNCH) ?? [];
  assert.equal(launches.length, 3);
  for (const launch of launches) {
    assert.match(launch, BACKUP_HELPER_RUN);
  }
});

test("hosted-ingest cgroup harness bounds its container logs via the shared policy", () => {
  const source = readFileSync(
    join(REPO_ROOT, "reference-implementation/scripts/hosted-ingest-memory-cgroup.ts"),
    "utf8"
  );
  assert.ok(HOSTED_INGEST_LAUNCH.test(source), "launch not found");
  assert.ok(HOSTED_INGEST_BOUNDED.test(source), "docker run lacks the shared log bound");
});

test("published-compose smoke: its volume-only generated override cannot replace the bounded logs", () => {
  const script = readFileSync(join(REPO_ROOT, "scripts/published-compose-bootstrap-smoke.sh"), "utf8");
  const override = script.slice(
    script.indexOf("printf '%s\\n' \\\n  'services:'"),
    script.indexOf('>"$OVERRIDE_FILE"')
  );
  assert.ok(override.includes("'services:'"), "generated override not found");
  assert.equal(override.includes("logging"), false, "the smoke override must not touch logging");
  // Same shape as the generated override: services -> volumes only.
  const dir = mkdtempSync(join(tmpdir(), "log-bounds-override-"));
  try {
    const file = join(dir, "override.yml");
    writeFileSync(
      file,
      "services:\n  reference:\n    volumes:\n      - type: bind\n        source: /tmp/x\n        target: /var/lib/pdpp\n"
    );
    const services = effectiveServices(["-f", "docker-compose.yml", "-f", file]);
    for (const [name, service] of Object.entries(services)) {
      assert.deepEqual(service.logging, BOUNDED, name);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
