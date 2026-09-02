// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Import the TypeScript file directly - tsx will handle the transpilation
const { npmPackMetadata } = await import("../scripts/pack-metadata.ts");

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commandFailurePattern = /Command failed: npm pack --foreground-scripts=false/;
const stderrPattern = /stderr:\nprepare failed/;
const stdoutPattern = /stdout:\nbuild detail/;

test("npm pack metadata does not depend on --json stdout: derives filename via readdir and files via tar -tzf", async () => {
  // The exact regression this fix closes: under installed npm 12.0.2, `npm
  // pack --json` can exit 0 with EMPTY captured stdout, so parsing it threw.
  // This fake `execute` never returns any JSON at all for the `npm pack`
  // invocation (mirroring that empty-stdout failure mode exactly) — if
  // npmPackMetadata still tried to JSON.parse npm's stdout, this test would
  // throw. Instead it must derive `filename` from the real newly-created
  // .tgz file in `cwd`, and `files` from a fake `tar -tzf` listing.
  const scratchDir = await mkdtemp(path.join(tmpdir(), "pdpp-pack-metadata-test-"));
  try {
    const invocations: Array<{ args: string[]; command: string }> = [];
    const packInfo = await npmPackMetadata({
      cwd: scratchDir,
      execute: async (command, args) => {
        invocations.push({ args: [...args], command });
        if (command === "npm") {
          // Real `npm pack` writes the tarball into cwd and (in this
          // fake) returns EMPTY stdout — the exact npm 12.0.2 symptom.
          await writeFile(path.join(scratchDir, "candidate-package-1.0.0.tgz"), "fake tarball bytes");
          return { stdout: "", stderr: "" };
        }
        if (command === "tar") {
          return {
            stdout: "package/\npackage/README.md\npackage/dist/index.js\n",
            stderr: "",
          };
        }
        throw new Error(`unexpected command in test fake: ${command}`);
      },
    });

    assert.equal(packInfo.filename, "candidate-package-1.0.0.tgz");
    assert.deepEqual(
      packInfo.files.map((f) => f.path),
      ["README.md", "dist/index.js"]
    );

    // Confirms the real command shape: no --json, --foreground-scripts=false
    // still passed, and tar invoked against the produced tarball's real path.
    const npmCall = invocations.find((i) => i.command === "npm");
    assert.deepEqual(npmCall?.args, ["pack", "--foreground-scripts=false"]);
    const tarCall = invocations.find((i) => i.command === "tar");
    assert.deepEqual(tarCall?.args, ["-tzf", path.join(scratchDir, "candidate-package-1.0.0.tgz")]);
  } finally {
    await rm(scratchDir, { force: true, recursive: true });
  }
});

test("npm pack metadata preserves lifecycle diagnostics on failure", async () => {
  const failure = Object.assign(new Error("npm exited 1"), {
    stderr: "prepare failed",
    stdout: "build detail",
  });
  const scratchDir = await mkdtemp(path.join(tmpdir(), "pdpp-pack-metadata-test-"));

  try {
    await assert.rejects(
      npmPackMetadata({
        cwd: scratchDir,
        execute: () => {
          throw failure;
        },
      }),
      (error) => {
        assert.match((error as Error).message, commandFailurePattern);
        assert.match((error as Error).message, stdoutPattern);
        assert.match((error as Error).message, stderrPattern);
        return true;
      }
    );
  } finally {
    await rm(scratchDir, { force: true, recursive: true });
  }
});

test("npm pack metadata rejects if npm pack produces zero or multiple new tarballs", async () => {
  // Mutant-sensitive: proves the code actually distinguishes "exactly one
  // newly-produced .tgz" rather than trusting any tarball present.
  const scratchDir = await mkdtemp(path.join(tmpdir(), "pdpp-pack-metadata-test-"));
  try {
    await assert.rejects(
      npmPackMetadata({
        cwd: scratchDir,
        execute: async (command) => {
          // npm pack "succeeds" but writes nothing — simulates a pack that
          // silently failed to produce a tarball.
          if (command === "npm") {
            return { stdout: "", stderr: "" };
          }
          throw new Error(`unexpected command in test fake: ${command}`);
        },
      }),
      /expected exactly one \.tgz/
    );
  } finally {
    await rm(scratchDir, { force: true, recursive: true });
  }
});

test("npm pack metadata strips the package/ tarball prefix so files[].path is package-root-relative", async () => {
  // Mutant-sensitive: if the `package/` prefix were NOT stripped,
  // validate-package.ts's assertions against literal paths like
  // "dist/index.js" would never match "package/dist/index.js".
  const scratchDir = await mkdtemp(path.join(tmpdir(), "pdpp-pack-metadata-test-"));
  try {
    const packInfo = await npmPackMetadata({
      cwd: scratchDir,
      execute: async (command) => {
        if (command === "npm") {
          await writeFile(path.join(scratchDir, "fixture.tgz"), "fake");
          return { stdout: "", stderr: "" };
        }
        return { stdout: "package/\npackage/a/b.js\n", stderr: "" };
      },
    });
    assert.deepEqual(
      packInfo.files.map((f) => f.path),
      ["a/b.js"]
    );
    assert.ok(
      packInfo.files.every((f) => !f.path.startsWith("package/")),
      "no file path should retain the tarball's package/ prefix"
    );
  } finally {
    await rm(scratchDir, { force: true, recursive: true });
  }
});

test("npm pack metadata correctly identifies the fresh tarball when an older .tgz with the SAME filename already exists in cwd", async () => {
  // Mutant-sensitive against a "diff against pre-existing filenames" bug:
  // npm overwrites a .tgz of the same package name/version IN PLACE, so it
  // never appears as "new" by name. A naive before/after name-diff would
  // find zero new files here and fail — this proves npmPackMetadata clears
  // any pre-existing .tgz first so the single .tgz found afterward is
  // unambiguous, even when the filename is identical across pack calls.
  const scratchDir = await mkdtemp(path.join(tmpdir(), "pdpp-pack-metadata-test-"));
  try {
    const tarballName = "candidate-package-1.0.0.tgz";
    await writeFile(path.join(scratchDir, tarballName), "stale tarball from a prior run");

    const packInfo = await npmPackMetadata({
      cwd: scratchDir,
      execute: async (command) => {
        if (command === "npm") {
          await writeFile(path.join(scratchDir, tarballName), "fresh tarball bytes");
          return { stdout: "", stderr: "" };
        }
        return { stdout: "package/\npackage/dist/index.js\n", stderr: "" };
      },
    });

    assert.equal(packInfo.filename, tarballName);
    assert.deepEqual(
      packInfo.files.map((f) => f.path),
      ["dist/index.js"]
    );
  } finally {
    await rm(scratchDir, { force: true, recursive: true });
  }
});

test("package validation builds once through npm pack prepack, not a root-install prepare", async () => {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));

  // `prepare` must stay absent: root `npm ci` runs every workspace's `prepare`
  // in lockfile order, not dependency order, which broke a plain install here
  // (see ab2146c). `prepack` only fires for `npm pack`/`publish`, so it is the
  // safe place to build before validate-package's `npmPackMetadata` call.
  assert.equal(packageJson.scripts.prepare, undefined);
  assert.equal(packageJson.scripts.prepack, "npm run build");
  assert.equal(packageJson.scripts["validate:package"], "tsx scripts/validate-package.ts");
});
