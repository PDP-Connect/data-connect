// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// docker/chrome-policy/distrusted-cas.json must name every compromised key,
// and every browser image must install it where its browser reads machine
// policy. deploy/docker/check-chrome-distrust-policy.sh proves the second
// part against built images; this test guards the policy content and the
// Dockerfiles CI does not build.

import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const POLICY_FILE = "docker/chrome-policy/distrusted-cas.json";

// SHA-256 of each compromised intermediate's SubjectPublicKeyInfo, as listed
// by Go's crypto/x509 distrustedSPKIHashes (golang/go@7f86f957633e). Chrome
// CRLSet 10864 blocks the six TLS keys; the two code-signing keys are
// distrusted as well because their private keys are equally recoverable.
const COMPROMISED_SPKIS: Record<string, string> = {
  "43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b": "EM OV TLS CA - G3B",
  "49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f": "EM DV TLS CA - G3C",
  "5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0": "EM EV TLS CA - G3C",
  "63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8": "EM OV TLS CA - G3C",
  "92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30": "EM OV CS CA - G3C",
  "e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41": "EM EV TLS CA - G3B",
  "ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105": "EM DV TLS CA - G3B",
  "ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6": "EM OV CS CA - G3B",
};

// Machine policy directories each image's browsers read: Chrome for Testing
// (Patchright's build), Chromium, and in n.eko also Google Chrome.
const INSTALLS: Record<string, string[]> = {
  Dockerfile: ["/etc/opt/chrome_for_testing/policies/managed", "/etc/chromium/policies/managed"],
  "deploy/docker/Dockerfile": ["/etc/opt/chrome_for_testing/policies/managed", "/etc/chromium/policies/managed"],
  "docker/neko/Dockerfile": [
    "/etc/opt/chrome_for_testing/policies/managed",
    "/etc/opt/chrome/policies/managed",
    "/etc/chromium/policies/managed",
  ],
};

function readPolicy(): unknown {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, POLICY_FILE), "utf8"));
}

// The RUN instruction, joined across its continuation lines, that mounts the
// policy file.
function policyInstallInstructions(dockerfile: string): string[] {
  const lines = readFileSync(path.join(REPO_ROOT, dockerfile), "utf8").split("\n");
  const instructions: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]?.startsWith("RUN ")) continue;
    let instruction = lines[index] ?? "";
    while (instruction.endsWith("\\") && index + 1 < lines.length) {
      instruction = `${instruction.slice(0, -1)} ${lines[++index]}`;
    }
    if (instruction.includes(`source=${POLICY_FILE}`)) instructions.push(instruction);
  }
  return instructions;
}

test("the policy distrusts exactly the compromised keys, one CA certificate per key", () => {
  const policy = readPolicy() as { CADistrustedCertificates: string[] };
  assert.deepEqual(Object.keys(policy), ["CADistrustedCertificates"]);

  const seen = new Map<string, string>();
  for (const entry of policy.CADistrustedCertificates) {
    const der = Buffer.from(entry, "base64");
    assert.equal(der.toString("base64"), entry, "each entry is canonical base64 DER");
    const certificate = new X509Certificate(der);
    assert.ok(certificate.ca, `${certificate.subject} is a CA certificate`);
    const spki = createHash("sha256")
      .update(certificate.publicKey.export({ format: "der", type: "spki" }))
      .digest("hex");
    const commonName = COMPROMISED_SPKIS[spki];
    assert.ok(commonName, `${certificate.subject} has an SPKI outside the compromised set: ${spki}`);
    assert.match(certificate.subject, new RegExp(`^CN=${commonName}$`, "m"));
    assert.ok(!seen.has(spki), `${commonName} is listed twice`);
    seen.set(spki, commonName);
  }
  assert.deepEqual([...seen.keys()].sort(), Object.keys(COMPROMISED_SPKIS).sort());
});

test("every browser Dockerfile installs the policy in each managed directory its browsers read", () => {
  for (const [dockerfile, directories] of Object.entries(INSTALLS)) {
    const instructions = policyInstallInstructions(dockerfile);
    assert.equal(instructions.length, 1, `${dockerfile} installs ${POLICY_FILE} in one RUN instruction`);
    const [instruction = ""] = instructions;
    assert.ok(
      instruction.includes('install -D -o root -g root -m 0644 /tmp/pdpp-distrusted-cas.json "${dir}/pdpp-distrusted-cas.json"'),
      `${dockerfile} installs the policy root-owned with mode 0644`
    );
    const loopDirectories = /for dir in ([^;]+);/.exec(instruction)?.[1]?.trim().split(/\s+/) ?? [];
    assert.deepEqual(loopDirectories.sort(), [...directories].sort(), `${dockerfile} policy directories`);
  }
});
