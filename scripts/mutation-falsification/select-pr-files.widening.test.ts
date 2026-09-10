// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression tests for ranges that used to be returned still cutting a
// statement in half.
//
// Stryker mutates a node only when the node lies wholly inside a `mutate` range
// (`locationIncluded`, not `locationOverlaps`), so a range ending mid-statement
// generates nothing for that statement while the run still reports completion.
// Widening used to short-circuit whenever both ends of a range happened to
// touch a statement boundary -- but those can be the boundaries of two
// different statements, with a third straddling the range, which is exactly
// when widening is needed. Both shapes below were reproduced against the real
// TypeScript AST and produced zero mutants for genuinely changed code.

import { describe, expect, it } from "vitest"
import ts from "typescript"
import { widenToStatements, type LineRange } from "./select-pr-files.ts"

/** The same boundary set `run-intent.ts` derives, so these test the real shapes. */
function statementBoundaries(source: string): LineRange[] {
  const sourceFile = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true)
  const boundaries: LineRange[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStatement(node) || ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) {
      boundaries.push({
        startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
      })
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return boundaries
}

describe("widening covers whole statements at both ends", () => {
  it("widens a range whose ends touch two different statements", () => {
    // boundaries: 1-1 (const first), 2-5 (setImmediate call), 3-3, 4-4.
    // Lines 1..3 start at a statement start and end at a statement end, but
    // they are different statements and the 2-5 call still straddles the range.
    const boundaries = statementBoundaries(
      ["const first = 1", "setImmediate(() => {", "  const inner = 2", "  return inner", "})"].join(
        "\n"
      )
    )
    const widened = widenToStatements([{ startLine: 1, endLine: 3 }], boundaries)
    expect(widened).toEqual([{ startLine: 1, endLine: 5 }])
    expect(widened.some((range) => range.startLine <= 2 && range.endLine >= 5)).toBe(true)
  })

  it("widens a hunk spanning two adjacent top-level statements", () => {
    // Nothing encloses a top-level range, so the old single "smallest statement
    // covering the whole range" lookup found no cover and returned the range
    // unchanged -- cutting both statements and yielding no mutants for either.
    const boundaries = statementBoundaries(
      ["const first =", "  1 +", "  2", "const second =", "  3 +", "  4"].join("\n")
    )
    expect(widenToStatements([{ startLine: 3, endLine: 4 }], boundaries)).toEqual([
      { startLine: 1, endLine: 6 },
    ])
  })

  it("widens each end independently and takes the union", () => {
    const boundaries: LineRange[] = [
      { startLine: 1, endLine: 4 },
      { startLine: 6, endLine: 9 },
    ]
    expect(widenToStatements([{ startLine: 3, endLine: 7 }], boundaries)).toEqual([
      { startLine: 1, endLine: 9 },
    ])
  })

  it("leaves a range that already covers whole statements unchanged", () => {
    const boundaries = statementBoundaries(["const a = 1", "const b = 2", "const c = 3"].join("\n"))
    expect(widenToStatements([{ startLine: 1, endLine: 2 }], boundaries)).toEqual([
      { startLine: 1, endLine: 2 },
    ])
  })

  it("keeps a one-line hunk that is itself a whole statement at one line", () => {
    // The tight case the scoping exists for: widening must not reach out to the
    // enclosing function when the changed line is a whole statement already.
    const boundaries = statementBoundaries(
      ["function outer() {", "  const a = 1", "  return a", "}"].join("\n")
    )
    expect(widenToStatements([{ startLine: 2, endLine: 2 }], boundaries)).toEqual([
      { startLine: 2, endLine: 2 },
    ])
  })

  it("widens a hunk that starts mid-statement to that statement's start", () => {
    const boundaries = statementBoundaries(
      ["const value = compute(", "  1,", "  2", ")", "const after = 3"].join("\n")
    )
    expect(widenToStatements([{ startLine: 2, endLine: 5 }], boundaries)).toEqual([
      { startLine: 1, endLine: 5 },
    ])
  })

  it("merges ranges that widening grew into each other", () => {
    // Two hunks, each cutting a different multi-line statement. Widening grows
    // them to 1-4 and 5-8, which are adjacent, so they leave as one entry
    // rather than asking Stryker the same question twice.
    const boundaries: LineRange[] = [
      { startLine: 1, endLine: 4 },
      { startLine: 5, endLine: 8 },
    ]
    expect(
      widenToStatements(
        [
          { startLine: 2, endLine: 4 },
          { startLine: 5, endLine: 6 },
        ],
        boundaries
      )
    ).toEqual([{ startLine: 1, endLine: 8 }])
  })

  it("leaves a hunk enclosed by a larger statement at its own lines", () => {
    // The tightness property, stated directly: an enclosing statement never
    // moves an edge, or a one-line change inside a long function would widen to
    // the function and then to the module.
    const boundaries: LineRange[] = [
      { startLine: 1, endLine: 400 },
      { startLine: 7, endLine: 7 },
    ]
    expect(widenToStatements([{ startLine: 7, endLine: 7 }], boundaries)).toEqual([
      { startLine: 7, endLine: 7 },
    ])
  })

  it("widens a hunk on a `} else {` line past the block it first grows to", () => {
    // Real ASTs produce statement spans that *partially* overlap: a consequent
    // block ends on the same line the alternative block starts. Boundaries here
    // are 1-9 (the function), 2-2, 3-7 (the if), 3-5 (consequent), 4-4, 5-7
    // (alternative), 6-6, 8-8.
    //
    // Editing `} else {` changes control flow for both branches. One widening
    // pass grows hunk 5-5 to the smallest statement containing it -- 3-5, the
    // consequent -- which leaves the 5-7 alternative straddled, so Stryker
    // generates nothing for `out = b + 2` while reporting completion. Growing
    // again from 3-5 reaches 3-7 and covers both branches.
    const boundaries = statementBoundaries(
      [
        "function f(a, b) {",
        "  let out = 0",
        "  if (a > 1) {",
        "    out = b + 1",
        "  } else {",
        "    out = b + 2",
        "  }",
        "  return out",
        "}",
      ].join("\n")
    )
    expect(widenToStatements([{ startLine: 5, endLine: 5 }], boundaries)).toEqual([
      { startLine: 3, endLine: 7 },
    ])
  })

  it("widens a nested `} else {` hunk to the innermost if, not the outer one", () => {
    // The same shape one level in, which also holds the fixpoint to the smallest
    // region containing the straddled statements whole: the inner if is 4-8, the
    // outer 3-11, and a hunk on the inner `} else {` must not reach the outer one
    // or the tightness this scoping exists for is lost.
    const boundaries = statementBoundaries(
      [
        "function f(a, b) {",
        "  let out = 0",
        "  if (a > 1) {",
        "    if (b > 1) {",
        "      out = 1",
        "    } else {",
        "      out = 2",
        "    }",
        "  } else {",
        "    out = 3",
        "  }",
        "  return out",
        "}",
      ].join("\n")
    )
    expect(widenToStatements([{ startLine: 6, endLine: 6 }], boundaries)).toEqual([
      { startLine: 4, endLine: 8 },
    ])
  })

  it("keeps growing while a further statement straddles the widened edge", () => {
    // A hunk that starts inside a nested statement and runs into the next
    // top-level statement. One pass grew the start edge to the innermost
    // statement it cut (3-4) and stopped, leaving the enclosing 1-5 statement
    // straddled -- so Stryker generated nothing for it, though this revision
    // changed lines inside it. Growing again from 3-6 reaches 1-5 and covers it.
    const boundaries: LineRange[] = [
      { startLine: 1, endLine: 5 },
      { startLine: 2, endLine: 2 },
      { startLine: 3, endLine: 4 },
      { startLine: 6, endLine: 6 },
    ]
    expect(widenToStatements([{ startLine: 4, endLine: 6 }], boundaries)).toEqual([
      { startLine: 1, endLine: 6 },
    ])
  })

  it("returns a range unchanged when the file has no statements", () => {
    expect(widenToStatements([{ startLine: 3, endLine: 4 }], [])).toEqual([
      { startLine: 3, endLine: 4 },
    ])
  })
})
