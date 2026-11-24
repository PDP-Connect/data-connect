// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the reference-revision header helpers
// (server/reference-revision.ts): explicit-input normalization, the header
// setter, and the git fallback's environment using a deterministic fake git.

import { strict as assert } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import {
  PDPP_REFERENCE_REVISION_HEADER,
  resolveReferenceRevision,
  setReferenceRevisionHeader,
} from "../server/reference-revision.ts";

test("resolveReferenceRevision returns an explicit revision trimmed", () => {
  assert.equal(resolveReferenceRevision({ referenceRevision: "  v1.2.3  " }), "v1.2.3");
});

test("resolveReferenceRevision collapses whitespace runs to a single dash", () => {
  assert.equal(resolveReferenceRevision({ referenceRevision: "a b\tc" }), "a-b-c");
  assert.equal(resolveReferenceRevision({ referenceRevision: "x   y" }), "x-y");
});

test("resolveReferenceRevision strips non-printable and non-ASCII characters", () => {
  // A control char (\x01) is stripped, leaving the printable neighbors joined.
  assert.equal(resolveReferenceRevision({ referenceRevision: "a\x01b" }), "ab");
  // A DEL char (\x7f, above the \x7e printable ceiling) is also stripped.
  assert.equal(resolveReferenceRevision({ referenceRevision: "a\x7fb" }), "ab");
});

test("resolveReferenceRevision preserves the printable ASCII range", () => {
  assert.equal(resolveReferenceRevision({ referenceRevision: "pdpp@1.0.0+abcdef" }), "pdpp@1.0.0+abcdef");
});

test("PDPP_REFERENCE_REVISION_HEADER is the canonical header name", () => {
  assert.equal(PDPP_REFERENCE_REVISION_HEADER, "PDPP-Reference-Revision");
});

test("setReferenceRevisionHeader writes the value under the canonical header", () => {
  const calls: [string, string][] = [];
  const res = { setHeader: (name: string, value: string) => calls.push([name, value]) };
  setReferenceRevisionHeader(res, "pdpp-reference@1.0.0+abc123");
  assert.deepEqual(calls, [[PDPP_REFERENCE_REVISION_HEADER, "pdpp-reference@1.0.0+abc123"]]);
});

test("resolveReferenceRevision disables optional git locks for every invocation", {
  skip: process.platform === "win32" ? "win32: the fake git is a shell script" : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "reference-revision-"));
  const savedEnv = {
    PATH: process.env.PATH,
    PDPP_REFERENCE_REVISION: process.env.PDPP_REFERENCE_REVISION,
    GIT_OPTIONAL_LOCKS: process.env.GIT_OPTIONAL_LOCKS,
  };
  const sha = "0123456789abcdef0123456789abcdef01234567";
  try {
    writeFileSync(join(directory, "git"), [
      "#!/bin/sh",
      'printf "%s:%s\\n" "$1" "${GIT_OPTIONAL_LOCKS-unset}" >> "${0%/*}/invocations"',
      `if [ "$1" = "rev-parse" ]; then printf "%s\\n" "${sha}"; fi`,
      "",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${directory}${delimiter}${savedEnv.PATH ?? ""}`;
    delete process.env.PDPP_REFERENCE_REVISION;
    process.env.GIT_OPTIONAL_LOCKS = "1";

    const revision = resolveReferenceRevision();
    assert.ok(revision.endsWith(`+${sha}`), revision);
    const invocations = readFileSync(join(directory, "invocations"), "utf8").trim().split("\n");
    assert.ok(invocations.some((line) => line.startsWith("status:")), "git status was invoked");
    for (const invocation of invocations) {
      assert.equal(invocation.split(":")[1], "0", invocation);
    }
    assert.equal(process.env.GIT_OPTIONAL_LOCKS, "1");
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
