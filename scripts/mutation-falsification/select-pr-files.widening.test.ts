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

  it("returns a range unchanged when the file has no statements", () => {
    expect(widenToStatements([{ startLine: 3, endLine: 4 }], [])).toEqual([
      { startLine: 3, endLine: 4 },
    ])
  })
})
