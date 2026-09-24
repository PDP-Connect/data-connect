// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Deterministic offline tests for the standalone Core image's first-boot
// credential bootstrap (deploy/railway/core-first-boot.ts).
//
// These pin the Docker quickstart's owner-gating contract:
//   - no PDPP_OWNER_PASSWORD -> generate, persist to the data dir, banner once;
//   - subsequent boots reuse the persisted password and never reprint it;
//   - the PDPP_OWNER_PASSWORD environment variable always wins;
//   - SQLite (quickstart) boots provision a credential encryption key file,
//     Postgres (managed-platform) boots keep the explicit fail-closed key
//     contract;
//   - the password is never emitted through the log/warn channels — the
//     one-time banner is the only print surface.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";

import {
  CREDENTIAL_KEY_FILENAME,
  prepareFirstBoot,
  resolveDataDir,
} from "../deploy/railway/core-first-boot.ts";

const OWNER_ONLY_MODE = 0o600;
const cleanupDirs: string[] = [];
// biome-ignore lint/suspicious/noBitwiseOperators: st.mode carries permission bits; masking with 0o777 is the standard idiom for reading a file's permission bits, not a confusable arithmetic operator.
const permissionBits = (mode: number) => mode & 0o777;

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDataDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "pdpp-first-boot-"));
  cleanupDirs.push(dir);
  return dir;
}

function capture() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

function noop() {
  // test doubles for log/warn that intentionally discard output
}

test("first boot leaves owner password setup to the server setup flow", () => {
  const dataDir = makeDataDir();
  const logs = capture();
  const result = prepareFirstBoot({ env: {}, dataDir, log: logs.log, warn: logs.log });

  assert.equal(result.env.PDPP_OWNER_PASSWORD, undefined);
  assert.ok(!existsSync(path.join(dataDir, "owner-password")), "does not persist an owner password");
  assert.ok(
    logs.lines.every((line) => !line.includes("PDPP_OWNER_PASSWORD")),
    "does not print owner password setup instructions"
  );
});

test("the PDPP_OWNER_PASSWORD environment variable remains an operator-owned override", () => {
  const dataDir = makeDataDir();
  const result = prepareFirstBoot({
    env: { PDPP_OWNER_PASSWORD: "operator-supplied" },
    dataDir,
    log: noop,
    warn: noop,
  });

  assert.equal(result.env.PDPP_OWNER_PASSWORD, undefined, "does not shadow the operator env");
  assert.ok(!existsSync(path.join(dataDir, "owner-password")));
});

test("an unpersistable data dir does not generate or print an owner password", () => {
  const dataDir = makeDataDir();
  // A path under a regular FILE cannot be created -> deterministic ENOTDIR.
  const blockedDir = path.join(dataDir, "blocker", "sub");
  writeFileSync(path.join(dataDir, "blocker"), "not a directory\n");

  const warned = capture();
  const result = prepareFirstBoot({ env: {}, dataDir: blockedDir, log: noop, warn: warned.log });

  assert.equal(result.env.PDPP_OWNER_PASSWORD, undefined);
  assert.ok(warned.lines.every((line) => !line.includes("PDPP_OWNER_PASSWORD")));
});

test("sqlite boots provision a stable credential encryption key file", () => {
  const dataDir = makeDataDir();
  const first = prepareFirstBoot({ env: {}, dataDir, log: noop, warn: noop });

  const keyFile = path.join(dataDir, CREDENTIAL_KEY_FILENAME);
  assert.equal(first.env.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE, keyFile);
  const key = readFileSync(keyFile, "utf8").trim();
  assert.equal(key.length, 64, "32 random bytes hex-encoded, like the Railway template secret(64)");
  assert.equal(permissionBits(statSync(keyFile).mode), OWNER_ONLY_MODE);

  const second = prepareFirstBoot({ env: {}, dataDir, log: noop, warn: noop });
  assert.equal(readFileSync(keyFile, "utf8").trim(), key, "key is stable across boots");
  assert.equal(second.env.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE, keyFile);
});

test("postgres boots keep the explicit fail-closed credential key contract", () => {
  const dataDir = makeDataDir();
  for (const env of [
    { DATABASE_URL: "postgresql://pdpp@db:5432/pdpp" },
    { PDPP_DATABASE_URL: "postgresql://pdpp@db:5432/pdpp" },
    { PDPP_STORAGE_BACKEND: "postgres", PDPP_DATABASE_URL: "postgresql://pdpp@db:5432/pdpp" },
  ]) {
    const result = prepareFirstBoot({ env, dataDir, log: noop, warn: noop });
    assert.equal(result.env.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE, undefined);
  }
});

test("a configured credential key provider is never shadowed", () => {
  const dataDir = makeDataDir();
  for (const env of [
    { PDPP_CREDENTIAL_ENCRYPTION_KEY: "operator-key" },
    { PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE: "/run/secrets/pdpp-key" },
  ]) {
    const result = prepareFirstBoot({ env, dataDir, log: noop, warn: noop });
    assert.equal(result.env.PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE, undefined);
  }
});

test("data dir defaults beside the configured SQLite database", () => {
  assert.equal(resolveDataDir({ PDPP_DB_PATH: "/var/lib/pdpp/pdpp.sqlite" }), "/var/lib/pdpp");
  assert.equal(resolveDataDir({ PDPP_DB_PATH: ":memory:" }), "/var/lib/pdpp");
  assert.equal(resolveDataDir({}), "/var/lib/pdpp");
});
