// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { hashCanonicalJson } from "@pdpp/collector-runtime";

import { selectedCollectionRelease, selectedReleaseForPin } from "../bin/pdpp-local-collector.ts";
import {
  COLLECTION_PROFILE_ENTRYPOINT,
  COLLECTION_PROFILE_MANIFEST,
  type CollectionProfilePin,
  installedCollectionProfile,
} from "../src/managed/collection-profiles.ts";

const createdRoots: string[] = [];
after(async () => {
  await Promise.all(createdRoots.map((root) => rm(root, { force: true, recursive: true })));
});

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const PROFILE = {
  connector_id: "fixture_connector",
  run_coverage: { version: 1 },
  streams: [{ coverage_stores: ["messages_store"], name: "messages" }],
};
const ENTRYPOINT = Buffer.from("export {};\n");

/** A pin whose two sha256 values match the bytes {@link installFixtureRelease} writes. */
function fixturePin(profileBytes: Buffer): CollectionProfilePin {
  return {
    connectorId: "fixture_connector",
    connectorKey: "fixture-connector",
    digest: `sha256:${"f".repeat(64)}`,
    entrypointSha256: sha256(ENTRYPOINT),
    profileSha256: sha256(profileBytes),
    version: "0.0.0-test",
  };
}

async function emptyInstallRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pdpp-selected-release-"));
  createdRoots.push(root);
  return root;
}

async function installFixtureRelease(profileBytes: Buffer): Promise<{ installRoot: string; pin: CollectionProfilePin }> {
  const installRoot = await emptyInstallRoot();
  const pin = fixturePin(Buffer.from(JSON.stringify(PROFILE)));
  const { directory } = installedCollectionProfile(installRoot, pin);
  await mkdir(join(directory, "profile"), { recursive: true });
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, COLLECTION_PROFILE_MANIFEST), profileBytes);
  await writeFile(join(directory, COLLECTION_PROFILE_ENTRYPOINT), ENTRYPOINT);
  return { installRoot, pin };
}

test("an installed release that matches its pin is selected, bound to the pin digest and profile fingerprint", async () => {
  const profileBytes = Buffer.from(JSON.stringify(PROFILE));
  const { installRoot, pin } = await installFixtureRelease(profileBytes);
  assert.deepEqual(selectedReleaseForPin(pin, installRoot), {
    artifactDigest: pin.digest,
    manifestFingerprint: hashCanonicalJson(PROFILE),
  });
});

test("an installed profile that no longer hashes to its pin selects no release", async () => {
  const { installRoot, pin } = await installFixtureRelease(Buffer.from(JSON.stringify({ ...PROFILE, streams: [] })));
  assert.equal(selectedReleaseForPin(pin, installRoot), null);
});

test("a pin that is not installed selects no release", async () => {
  const pin = fixturePin(Buffer.from(JSON.stringify(PROFILE)));
  assert.equal(selectedReleaseForPin(pin, await emptyInstallRoot()), null);
});

test("an unpinned, absent, or uninstalled connector selects no release", async () => {
  const installRoot = await emptyInstallRoot();
  assert.equal(selectedCollectionRelease("gmail", installRoot), null);
  assert.equal(selectedCollectionRelease(undefined, installRoot), null);
  assert.equal(selectedCollectionRelease("claude-code", installRoot), null, "pinned but not installed");
});
