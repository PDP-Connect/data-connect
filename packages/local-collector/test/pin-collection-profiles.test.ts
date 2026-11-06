// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs `pin-collection-profiles.ts` end to end against a temp tree and a fake
 * catalog. A release the run was asked to keep or move to, and the catalog no
 * longer lists, must fail the run with every existing output untouched; it
 * must not drop the connector from the pins.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { type PinScriptDeps, runPinScript } from "../scripts/pin-collection-profiles.ts";

const DEFINITIONS = [{ connector_id: "codex" }, { connector_id: "imessage" }];

interface Tree {
  readonly deps: PinScriptDeps;
  readonly logs: string[];
  readonly snapshot: () => Record<string, string>;
  readonly cleanup: () => void;
}

function release(version: string) {
  return { digest: `sha256:${version}`, version };
}

function tree(options: {
  readonly argv: readonly string[];
  readonly catalog: Record<string, readonly string[]>;
  readonly currentPins: readonly { connectorKey: string; version: string }[];
}): Tree {
  const root = mkdtempSync(path.join(tmpdir(), "pin-script-"));
  const pinsModule = path.join(root, "pins.generated.ts");
  const referenceProfileDir = path.join(root, "profiles");
  const holdsFile = path.join(root, "holds.json");
  mkdirSync(referenceProfileDir);
  writeFileSync(holdsFile, "{}\n");
  writeFileSync(pinsModule, "OLD PINS MODULE\n");
  for (const { connectorKey, version } of options.currentPins) {
    writeFileSync(path.join(referenceProfileDir, `${connectorKey}.json`), `{"old":"${version}"}\n`);
    writeFileSync(path.join(referenceProfileDir, `${connectorKey}.pin.json`), `{"old_pin":"${version}"}\n`);
  }
  const logs: string[] = [];
  const deps: PinScriptDeps = {
    argv: options.argv,
    currentPins: options.currentPins,
    definitions: DEFINITIONS,
    fetchCatalog: async () => ({
      catalog: {
        connectors: Object.entries(options.catalog).map(([connector_key, versions]) => ({
          connector_key,
          latest: release(versions.at(-1) ?? ""),
          versions: versions.map(release),
        })),
      },
    }),
    fetchResolvedArtifact: async (_context, artifact) => ({
      checksums: { entrypoint: "entry", manifest: "manifest" },
      manifestBuffer: Buffer.from(`{"profile":"${String(artifact.connectorKey)} ${String(artifact.version)}"}\n`),
      oci: { digest: `sha256:${String(artifact.version)}` },
    }),
    holdsFile,
    log: (line) => logs.push(line),
    pinsModule,
    referenceProfileDir,
  };
  const snapshot = () => {
    const files: Record<string, string> = { "pins.generated.ts": readFileSync(pinsModule, "utf8") };
    for (const name of readdirSync(referenceProfileDir).sort()) {
      files[`profiles/${name}`] = readFileSync(path.join(referenceProfileDir, name), "utf8");
    }
    return files;
  };
  return { cleanup: () => rmSync(root, { force: true, recursive: true }), deps, logs, snapshot };
}

const BOTH_PINNED = [
  { connectorKey: "codex", version: "0.3.3" },
  { connectorKey: "imessage", version: "0.1.25" },
];

async function assertRefusedAndUntouched(options: Parameters<typeof tree>[0], message: RegExp) {
  const t = tree(options);
  try {
    const before = t.snapshot();
    await assert.rejects(runPinScript(t.deps), message);
    assert.deepEqual(t.snapshot(), before, "a refused run leaves every pin output as it was");
  } finally {
    t.cleanup();
  }
}

test("--version naming a release the catalog does not list fails and keeps every output", async () => {
  await assertRefusedAndUntouched(
    {
      argv: ["--version", "codex=99.99.99"],
      catalog: { codex: ["0.3.3", "0.3.5"], imessage: ["0.1.25"] },
      currentPins: BOTH_PINNED,
    },
    /cannot pin codex.*99\.99\.99/
  );
});

test("a current pin whose release left the catalog fails and keeps every output", async () => {
  await assertRefusedAndUntouched(
    {
      argv: [],
      catalog: { codex: ["0.3.5"], imessage: ["0.1.25"] },
      currentPins: BOTH_PINNED,
    },
    /cannot pin codex.*0\.3\.3/
  );
});

test("--latest on a pinned connector the catalog no longer lists fails and keeps every output", async () => {
  await assertRefusedAndUntouched(
    {
      argv: ["--latest"],
      catalog: { imessage: ["0.1.25", "0.1.26"] },
      currentPins: BOTH_PINNED,
    },
    /cannot pin codex/
  );
});

test("a connector with no pin and no request that the catalog does not list is left out, and the rest is written", async () => {
  const t = tree({
    argv: [],
    catalog: { imessage: ["0.1.25"] },
    currentPins: [{ connectorKey: "imessage", version: "0.1.25" }],
  });
  try {
    await runPinScript(t.deps);
    assert.ok(t.logs.some((line) => line.startsWith("unpinned codex")));
    const files = t.snapshot();
    assert.deepEqual(Object.keys(files), [
      "pins.generated.ts",
      "profiles/imessage.json",
      "profiles/imessage.pin.json",
    ]);
    assert.match(files["pins.generated.ts"] ?? "", /"connectorKey": "imessage"/);
    assert.doesNotMatch(files["pins.generated.ts"] ?? "", /"connectorKey": "codex"/);
  } finally {
    t.cleanup();
  }
});

test("a bare run rewrites both connectors from the pinned releases", async () => {
  const t = tree({
    argv: [],
    catalog: { codex: ["0.3.3", "0.3.5"], imessage: ["0.1.25", "0.1.26"] },
    currentPins: BOTH_PINNED,
  });
  try {
    await runPinScript(t.deps);
    const files = t.snapshot();
    assert.match(files["pins.generated.ts"] ?? "", /"version": "0\.3\.3"/);
    assert.match(files["pins.generated.ts"] ?? "", /"version": "0\.1\.25"/);
    assert.equal(files["profiles/codex.json"], '{"profile":"codex 0.3.3"}\n');
  } finally {
    t.cleanup();
  }
});
