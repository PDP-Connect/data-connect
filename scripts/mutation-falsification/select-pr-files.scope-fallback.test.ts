// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression tests for the two ways changed-line scope used to fail open.
//
// Both were reproduced by execution against a real git repository before they
// were fixed: a file the diff selected could end up mutated in full, recorded
// as `whole_file` and logged as "added in this revision", when the revision had
// added nothing. The cases here are the exact shapes that produced it -- a
// 100%-similarity rename and a modification whose only hunk is a pure deletion
// -- plus the general form, a selected file the caller supplied no ranges for.
//
// Whole-file scope is now a decision the evidence has to state: it is reachable
// only from status `A`, and any other selected file without ranges is an error
// rather than a silent widening back to the cost this scoping exists to remove.

import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  freezeIntent,
  parseNameStatusZ,
  parseUnifiedZeroHunks,
  type LineRange,
} from "./select-pr-files.ts"

const referenceCohort = {
  name: "reference-implementation" as const,
  root: "reference-implementation",
  productionPrefixes: ["reference-implementation/server", "reference-implementation/scripts"],
}

const executionInputs = {
  cohortRoot: "reference-implementation",
  configDigest: "sha256:x",
  toolVersion: "10.0.0",
  runtimeVersion: "v22.23.1",
  lockfileDigests: [],
}

function freeze(nameStatusZ: string, hunks: ReadonlyMap<string, readonly LineRange[]>) {
  return freezeIntent({
    cohort: referenceCohort,
    baseCommit: "base",
    headCommit: "head",
    diff: parseNameStatusZ(nameStatusZ),
    executionInputs,
    hunks,
  })
}

describe("a selected file with no derived ranges is an error, not whole-file scope", () => {
  it("rejects a pure rename that git reports with no hunks", () => {
    // `git diff -U0` emits no hunk header at all for a 100%-similarity rename,
    // so the destination path is absent from the hunks map. Read as "no ranges"
    // this used to mutate the whole destination file for a revision that
    // changed none of its bytes.
    expect(() =>
      freeze(
        "R100\0reference-implementation/server/old.ts\0reference-implementation/server/index.ts\0",
        new Map()
      )
    ).toThrow(/server\/index\.ts/)
  })

  it("names the file and the status in the error", () => {
    expect(() =>
      freeze(
        "R100\0reference-implementation/server/old.ts\0reference-implementation/server/index.ts\0",
        new Map()
      )
    ).toThrow(/R100/)
  })

  it("rejects a modified file absent from the hunks map", () => {
    expect(() => freeze("M\0reference-implementation/server/index.ts\0", new Map())).toThrow(
      /no changed line ranges/
    )
  })

  it("excludes a modified file whose only hunk was a pure deletion", () => {
    // A `+N,0` hunk contributes no range by design -- deleted content cannot
    // carry a fault into head -- so a file whose every hunk is a deletion
    // reaches this point with an empty range list from a legitimate derivation.
    // There is no line left in head to mutate, so the file is excluded with a
    // recorded reason. Failing the run instead would make an ordinary revision
    // -- one that only removes a line -- unable to produce evidence at all.
    const intent = freeze(
      "M\0reference-implementation/server/index.ts\0",
      new Map([["reference-implementation/server/index.ts", []]])
    )
    expect(intent.mutate).toEqual([])
    expect(intent.scope).toEqual([])
    expect(intent.excluded).toContainEqual({
      path: "reference-implementation/server/index.ts",
      reason: "no_mutable_lines",
    })
  })

  it("reports not_applicable when a deletion-only change is all the revision touched", () => {
    // The cohort changed no mutable line, which is the same standing as a
    // test-only revision: no evidence exists, and that is neither a pass nor a
    // failure. The mutation job reads this to decide it has nothing to run.
    const intent = freeze(
      "M\0reference-implementation/server/index.ts\0",
      new Map([["reference-implementation/server/index.ts", []]])
    )
    expect(intent.applicability).toBe("not_applicable")
  })

  it("still mutates the added lines of a file that both added and deleted lines", () => {
    // Only a file with no surviving added range is excluded. A modification
    // that deletes in one hunk and adds in another is still scoped to what it
    // added, so the exclusion cannot swallow a real change.
    const intent = freeze(
      "M\0reference-implementation/server/index.ts\0",
      new Map([["reference-implementation/server/index.ts", [{ startLine: 12, endLine: 14 }]]])
    )
    expect(intent.mutate).toEqual(["server/index.ts:12-14"])
    expect(intent.excluded).not.toContainEqual(
      expect.objectContaining({ reason: "no_mutable_lines" })
    )
  })

  it("still scopes a genuinely added file to the whole file", () => {
    const intent = freeze("A\0reference-implementation/server/new-route.ts\0", new Map())
    expect(intent.mutate).toEqual(["server/new-route.ts"])
    expect(intent.scope).toEqual([
      { path: "server/new-route.ts", kind: "whole_file", ranges: [] },
    ])
  })

  it("prefers the derived ranges of a rename that did change content", () => {
    const intent = freeze(
      "R092\0reference-implementation/server/old.ts\0reference-implementation/server/index.ts\0",
      new Map([
        ["reference-implementation/server/index.ts", [{ startLine: 5, endLine: 9 }]],
      ])
    )
    expect(intent.mutate).toEqual(["server/index.ts:5-9"])
    expect(intent.scope[0]?.kind).toBe("changed_ranges")
  })
})

describe("end-to-end over a real git repository", () => {
  it("refuses a pure rename and keeps every other shape scoped", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-fallback-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
    try {
      git("init", "-q", ".")
      git("config", "user.email", "t@e.com")
      git("config", "user.name", "T")
      writeFileSync(join(dir, "big.ts"), "const a = 1\nconst b = 2\nconst c = 3\n")
      writeFileSync(join(dir, "del.ts"), "const z = 9\n")
      writeFileSync(join(dir, "multi.ts"), "const p = 1\nconst q = 2\nconst r = 3\n")
      git("add", "-A")
      git("commit", "-qm", "base")
      const base = git("rev-parse", "HEAD").trim()
      git("mv", "big.ts", "renamed.ts")
      git("rm", "-q", "del.ts")
      writeFileSync(join(dir, "multi.ts"), "const p = 1\nconst r = 3\nconst s = 4\n")
      writeFileSync(join(dir, "brand-new.ts"), "export const nn = 1\n")
      git("add", "-A")
      git("commit", "-qm", "head")
      const head = git("rev-parse", "HEAD").trim()

      const hunkFiles = parseUnifiedZeroHunks(git("diff", "-U0", "--no-color", base, head))
      // The pure-deletion hunk (`+1,0`) contributes no range, the deleted file
      // is skipped, and git supplies nothing at all for the pure rename. These
      // three facts are what the classifier has to survive.
      expect(hunkFiles.find((file) => file.path === "multi.ts")?.ranges).toEqual([
        { startLine: 3, endLine: 3 },
      ])
      expect(hunkFiles.some((file) => file.path === "del.ts")).toBe(false)
      expect(hunkFiles.some((file) => file.path === "renamed.ts")).toBe(false)

      const clientCohort = { name: "client" as const, root: ".", productionPrefixes: [""] }
      const diff = parseNameStatusZ(
        git("diff", "--name-status", "-z", "--diff-filter=ACMRTD", "-M", base, head)
      )
      const hunks = new Map(hunkFiles.map((file) => [file.path, file.ranges]))

      expect(() =>
        freezeIntent({
          cohort: clientCohort,
          baseCommit: base,
          headCommit: head,
          diff,
          executionInputs,
          hunks,
        })
      ).toThrow(/renamed\.ts/)

      // With the unchanged rename excluded from the diff, every remaining shape
      // scopes as it should: the added file whole, the edited file by range,
      // the deleted file recorded as excluded.
      const withoutRename = diff.filter((entry) => entry.path !== "renamed.ts")
      const intent = freezeIntent({
        cohort: clientCohort,
        baseCommit: base,
        headCommit: head,
        diff: withoutRename,
        executionInputs,
        hunks,
      })
      expect(intent.mutate).toEqual(["brand-new.ts", "multi.ts:3-3"])
      expect(intent.excluded).toEqual([{ path: "del.ts", reason: "deleted" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
