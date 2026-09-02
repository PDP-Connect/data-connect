#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Sigstore attestation verification (see npm-release.yml's "Verify npm
// provenance attestation" step) proves the published tarballs were built
// by this repo's workflow at this commit — provenance. It says nothing
// about whether @pdpp/collector-runtime's published dependency on
// @pdpp/connector-protocol actually resolves to code that exports what
// collector-runtime's own source imports — semantic compatibility. This
// script proves that half: install both just-published packages together
// into an empty scratch directory (no workspace, no local `file:`/`link:`
// resolution — a real npm install against the real registry) and import
// every @pdpp/connector-protocol export collector-runtime's source uses.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function fail(message) {
  process.stderr.write(`[verify-packed-install-capability-exports] ${message}\n`);
  process.exit(1);
}

const version = process.argv[2];
if (!version) {
  fail("Usage: verify-packed-install-capability-exports.mjs <version>");
}

const scratchDir = await mkdtemp(join(tmpdir(), "pdpp-packed-install-proof-"));

try {
  await writeFile(
    join(scratchDir, "package.json"),
    `${JSON.stringify(
      {
        name: "pdpp-packed-install-proof",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@pdpp/collector-runtime": version,
          "@pdpp/connector-protocol": version,
        },
      },
      null,
      2
    )}\n`
  );

  process.stdout.write(`[verify-packed-install-capability-exports] npm install in ${scratchDir}\n`);
  await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: scratchDir });

  const checkScript = `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as runtimeIndex from "@pdpp/collector-runtime";
import * as collectorRunner from "@pdpp/collector-runtime/collector-runner";
import * as localDeviceClient from "@pdpp/collector-runtime/local-device-client";
import * as localDeviceEnvelope from "@pdpp/collector-runtime/local-device-envelope";
import {
  CONNECTOR_PROTOCOL_VERSION,
  isConnectorProtocolCapabilityArray,
  validateStreamEvidenceCounts,
} from "@pdpp/connector-protocol";
import { retryAfterMsFromHeaders } from "@pdpp/connector-protocol/http-retry";

// Resolve the installed package's own package.json by walking up from its
// entry point rather than importing a "./package.json" subpath — the
// package's exports map does not (and need not) expose that subpath.
const entryUrl = import.meta.resolve("@pdpp/connector-protocol");
const entryPath = fileURLToPath(entryUrl);
const packageRootMatch = entryPath.match(/^(.*\\/node_modules\\/@pdpp\\/connector-protocol)\\//);
if (!packageRootMatch) {
  throw new Error(\`could not locate @pdpp/connector-protocol package root from resolved entry \${entryPath}\`);
}
const resolvedProtocolPkg = JSON.parse(readFileSync(\`\${packageRootMatch[1]}/package.json\`, "utf8"));
assert.equal(
  resolvedProtocolPkg.version,
  ${JSON.stringify(version)},
  "resolved @pdpp/connector-protocol version must equal the released version"
);

for (const [label, value] of Object.entries({
  "collector-runtime barrel": runtimeIndex,
  "collector-runtime/collector-runner": collectorRunner,
  "collector-runtime/local-device-client": localDeviceClient,
  "collector-runtime/local-device-envelope": localDeviceEnvelope,
  "connector-protocol CONNECTOR_PROTOCOL_VERSION": CONNECTOR_PROTOCOL_VERSION,
  "connector-protocol isConnectorProtocolCapabilityArray": isConnectorProtocolCapabilityArray,
  "connector-protocol validateStreamEvidenceCounts": validateStreamEvidenceCounts,
  "connector-protocol/http-retry retryAfterMsFromHeaders": retryAfterMsFromHeaders,
})) {
  assert.notEqual(value, undefined, \`\${label} is undefined\`);
}

assert.equal(typeof isConnectorProtocolCapabilityArray, "function");
assert.equal(typeof validateStreamEvidenceCounts, "function");
assert.equal(isConnectorProtocolCapabilityArray(["STREAM_EVIDENCE"]), true);

console.log("[verify-packed-install-capability-exports] all capability exports resolved and ran correctly");
`;

  await writeFile(join(scratchDir, "check.mjs"), checkScript);
  const { stdout } = await run("node", ["check.mjs"], { cwd: scratchDir });
  process.stdout.write(stdout);
} finally {
  await rm(scratchDir, { recursive: true, force: true });
}
