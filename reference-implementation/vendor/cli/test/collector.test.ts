// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { COLLECTOR_HELP, runCollector } from "../src/collector/commands.ts";
import { CollectorUsageError } from "../src/collector/errors.ts";
import { resolveLocalCollectorPackage, resolveTsxBinary, spawnCollectorRunner } from "../src/collector/runner.ts";

// The bin facade (bin/pdpp.js) imports the emitted `dist/src/index.js`, so
// subprocess smoke tests must exercise the built artifact — npm test builds
// before running tests (see package.json), so dist/ is guaranteed present.
const binPath = fileURLToPath(new URL("../dist/bin/pdpp.js", import.meta.url));

function makeIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write: (chunk) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += chunk;
        },
      },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}


const BUILT_BIN = join("dist", "local-collector", "bin", "pdpp-local-collector.js");
const SOURCE_BIN = join("bin", "pdpp-local-collector.ts");

/** A fake @pdpp/local-collector package on disk with the chosen entrypoints. */
async function fakeLocalCollector({ built, source }: { built: boolean; source: boolean }) {
  const packageDir = await mkdtemp(join(tmpdir(), "pdpp-fake-local-collector-"));
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ bin: { "pdpp-local-collector": BUILT_BIN } }));
  if (built) {
    await mkdir(join(packageDir, "dist", "local-collector", "bin"), { recursive: true });
    await writeFile(join(packageDir, BUILT_BIN), "");
  }
  if (source) {
    await mkdir(join(packageDir, "bin"), { recursive: true });
    await writeFile(join(packageDir, SOURCE_BIN), "");
  }
  return { manifestPath: join(packageDir, "package.json"), packageDir };
}

function recordingSpawn(exitCode: number) {
  const spawned: { binary: string; args: string[]; options: Record<string, unknown> }[] = [];
  const spawnFn = (binary, args, options) => {
    spawned.push({ binary, args, options });
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", exitCode, null));
    return child;
  };
  return { spawned, spawnFn };
}

test("collector help lists the guided and manual subcommands and both flows", async () => {
  const io = makeIo();
  const code = await runCollector([], io.io);
  assert.equal(code, 0);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /pdpp collector setup/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /pdpp collector connectors/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /pdpp collector logout/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /pdpp collector advertise/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /pdpp collector enroll/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /pdpp collector run/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /Guided flow/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /Manual \/ scriptable flow/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /device-scoped/);
});

test("collector help advertises the published @pdpp/local-collector path", async () => {
  const io = makeIo();
  const code = await runCollector([], io.io);
  assert.equal(code, 0);
  // The supported public path is the npm-installable runner, not a monorepo clone.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /@pdpp\/local-collector/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /npm i -g @pdpp\/local-collector|npx -y @pdpp\/local-collector/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(io.stdout, /monorepo only/i);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.doesNotMatch(io.stdout, /git clone/);
});

test("collector help names device_id, device_token, and connection id from enroll", async () => {
  const io = makeIo();
  const code = await runCollector([], io.io);
  assert.equal(code, 0);
  // Enrollment still returns source_instance_id, but operator-facing run
  // commands should name it as the local connection id.
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /device_id/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /device_token/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /source_instance_id/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /PDPP_CONNECTION_ID/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stdout, /--connection-id/);
});

test("top-level help advertises the collector namespace", () => {
  const result = spawnSync(process.execPath, [binPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.stdout, /pdpp collector advertise/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.stdout, /pdpp collector enroll/);
});

test("unknown collector subcommand exits 64 with help", async () => {
  const io = makeIo();
  const code = await runCollector(["frobnicate"], io.io);
  assert.equal(code, 64);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stderr, /Unknown collector subcommand: frobnicate/);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(io.stderr, /pdpp collector run/);
});

test("local-collector resolves from inside the repository workspace", () => {
  const cliSrcDir = fileURLToPath(new URL("../src/collector/", import.meta.url));
  const resolved = resolveLocalCollectorPackage(cliSrcDir);
  assert.ok(resolved, "expected the workspace to link @pdpp/local-collector into node_modules");
  const manifest = JSON.parse(readFileSync(resolved.manifestPath, "utf8"));
  assert.equal(manifest.name, "@pdpp/local-collector");
});

test("local-collector does not resolve outside any install", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "pdpp-collector-isolated-"));
  assert.equal(resolveLocalCollectorPackage(tmp), null);
});

test("spawnCollectorRunner throws an install hint when local-collector is not installed", async () => {
  await assert.rejects(
    () =>
      spawnCollectorRunner("advertise", [], {
        localCollector: null,
        tsxBinary: "/fake/tsx",
        spawnFn: () => {
          throw new Error("should not spawn");
        },
      }),
    (err) => {
      assert.ok(err instanceof CollectorUsageError);
      // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
      assert.match(err.message, /npm i -g @pdpp\/local-collector|npx -y @pdpp\/local-collector/);
      return true;
    }
  );
});

test("spawnCollectorRunner reports a package with neither a built nor a source bin", async () => {
  const localCollector = await fakeLocalCollector({ built: false, source: false });
  await assert.rejects(
    () => spawnCollectorRunner("advertise", [], { localCollector, tsxBinary: "/tsx", spawnFn: recordingSpawn(0).spawnFn }),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /missing its bin entrypoint/
  );
});

test("spawnCollectorRunner needs tsx to run an unbuilt checkout", async () => {
  const localCollector = await fakeLocalCollector({ built: false, source: true });
  await assert.rejects(
    () =>
      spawnCollectorRunner("advertise", [], {
        localCollector,
        tsxBinary: null,
        spawnFn: () => {
          throw new Error("should not spawn");
        },
      }),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /not built and tsx was not found/
  );
});

test("spawnCollectorRunner runs an unbuilt checkout's source through tsx and forwards args, env, and exit code", async () => {
  const localCollector = await fakeLocalCollector({ built: false, source: true });
  const { spawned, spawnFn } = recordingSpawn(7);

  const code = await spawnCollectorRunner("run", ["--base-url", "http://x", "--connector", "codex"], {
    localCollector,
    tsxBinary: "/tsx",
    spawnFn,
    env: { PDPP_LOCAL_DEVICE_TOKEN: "tok" },
    stdio: "pipe",
  });

  assert.equal(code, 7);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].binary, "/tsx");
  assert.deepEqual(spawned[0].args, [
    join(localCollector.packageDir, SOURCE_BIN),
    "run",
    "--base-url",
    "http://x",
    "--connector",
    "codex",
  ]);
  assert.equal(spawned[0].options.env.PDPP_LOCAL_DEVICE_TOKEN, "tok");
  assert.equal(spawned[0].options.stdio, "pipe");
});

test("spawnCollectorRunner prefers the built bin, run with this Node, over the source entrypoint", async () => {
  const localCollector = await fakeLocalCollector({ built: true, source: true });
  const { spawned, spawnFn } = recordingSpawn(0);

  await spawnCollectorRunner("advertise", [], { localCollector, tsxBinary: "/tsx", spawnFn, stdio: "pipe" });

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].binary, process.execPath);
  assert.equal(spawned[0].args[0], join(localCollector.packageDir, BUILT_BIN));
});

test("spawnCollectorRunner rejects when child terminates by signal", async () => {
  const localCollector = await fakeLocalCollector({ built: true, source: false });
  const fakeSpawn = () => {
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", null, "SIGTERM"));
    return child;
  };

  await assert.rejects(
    () => spawnCollectorRunner("advertise", [], { localCollector, tsxBinary: "/tsx", spawnFn: fakeSpawn }),
    // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
    /terminated by signal SIGTERM/
  );
});

test("runCli dispatches `collector` to the runner", async () => {
  const localCollector = resolveLocalCollectorPackage();
  const tsxBinary = resolveTsxBinary();
  assert.ok(localCollector, "expected the workspace @pdpp/local-collector to resolve");
  assert.ok(tsxBinary, "expected workspace tsx to exist");

  const io = makeIo();
  const code = await runCollector(["advertise"], io.io);
  assert.equal(code, 0);
  assert.equal(io.stdout, "");
});

test("pdpp collector advertise (real subprocess) emits the capability profile", () => {
  // Spawn the built pdpp bin, let it spawn the workspace local-collector,
  // verify the JSON profile reaches stdout.
  const result = spawnSync(process.execPath, [binPath, "collector", "advertise"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, `stderr=${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  // The binding set belongs to @pdpp/collector-runtime and is tested there;
  // this test proves only that the CLI reaches the runner and relays its output.
  assert.equal(parsed.runtime, "collector");
  assert.ok(Array.isArray(parsed.bindings) && parsed.bindings.length > 0);
});

test("pdpp collector enroll missing --code surfaces collector-runner usage error", () => {
  const result = spawnSync(process.execPath, [binPath, "collector", "enroll", "--base-url", "http://127.0.0.1:1"], {
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.notEqual(result.status, 0);
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(result.stderr, /enroll requires --code/);
});

test("COLLECTOR_HELP names the openspec design doc as source of truth", () => {
  // biome-ignore lint/performance/useTopLevelRegex: inline assertion literal scoped to this test case; hoisting would separate the pattern from the single call site it documents.
  assert.match(COLLECTOR_HELP, /openspec\/changes\/publish-pdpp-local-collector/);
});

test("@pdpp/cli does not declare a runtime dependency on @pdpp/local-collector", async () => {
  // The shim resolves the runner lazily; declaring it as a runtime dependency
  // would re-couple slim @pdpp/cli to the runner's release cadence.
  const manifest = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8"
    )
  );
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (manifest[field] && "@pdpp/local-collector" in manifest[field]) {
      assert.fail(`@pdpp/cli must not declare @pdpp/local-collector in ${field}; the shim resolves it lazily.`);
    }
  }
});
