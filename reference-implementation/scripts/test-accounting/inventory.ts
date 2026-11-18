// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared test-accounting path, digest, and tracked-file utilities.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const EXECUTABLE_TEST_SUFFIX = /\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx|py|sh)$/;
export const RUN_AUTHORITY_SCHEMA = "pdpp.test-run-authority/v1";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
const LEADING_DOT_SLASH_PATTERN = /^\.\//;

function fail(message: string): never {
  throw new Error(`test accounting: ${message}`);
}
function git(args: string[], cwd: string = process.cwd()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
export function trackedFiles(cwd: string = process.cwd()): string[] {
  return git(["ls-files", "-z"], cwd).split("\0").filter(Boolean).map(normalizePath).sort();
}

export function normalizePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("path must be a non-empty string");
  }
  const path = value.replaceAll("\\", "/").replace(LEADING_DOT_SLASH_PATTERN, "");
  if (path.startsWith("/") || path.split("/").includes("..")) {
    fail(`path must be repository-relative: ${value}`);
  }
  return path;
}

export function containedPath(
  root: string,
  path: string,
  { existing = false, label = "path" }: { existing?: boolean; label?: string } = {}
): string {
  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, normalizePath(path));
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}/`)) {
    fail(`${label} escapes repository: ${path}`);
  }
  if (!existing) {
    return candidate;
  }
  let target: string;
  try {
    target = realpathSync(candidate);
  } catch {
    fail(`${label} is missing: ${path}`);
  }
  if (target !== rootReal && !target.startsWith(`${rootReal}/`)) {
    fail(`${label} escapes repository: ${path}`);
  }
  return target;
}

export function contentDigest(value: string | Buffer): string {
  return hash(value);
}
