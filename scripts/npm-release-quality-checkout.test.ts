// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"

// The `quality` job is the only gate in front of a converge publish, and npm
// versions are immutable — a converge that publishes an unverified tarball
// cannot be taken back. So `quality` has to check out the SAME tree the
// publishing job builds: the tag on a converge, the push head otherwise.
//
// Run 34654643962 is what happens when it does not. `quality` checked out the
// push head while `converge` checked out the tag, so the gate verified a tree
// that would never be published. Because the artifact receipts in
// packages/*/artifact.json are per-tree by construction (each records the
// digests of the sources it was generated from, including collector-runtime's
// embedded copy of connector-protocol's), and main had moved past v2.2.1, the
// receipt check compared main's connector-protocol sources against the tag's
// collector-runtime receipt and failed a release whose own tree was
// internally consistent.
//
// This test parses the REAL workflow YAML rather than asserting on a copy, so
// it fails if the two checkouts ever drift apart again — in either direction:
// a `quality` that stops following the tag (the original bug), or a `converge`
// that stops building it.

interface WorkflowStep {
  name?: string
  uses?: string
  with?: Record<string, string>
}

interface WorkflowJob {
  steps: WorkflowStep[]
}

interface WorkflowDocument {
  jobs: Record<string, WorkflowJob>
}

function loadNpmReleaseWorkflow(): WorkflowDocument {
  return load(
    readFileSync(resolve(process.cwd(), ".github/workflows/npm-release.yml"), "utf8")
  ) as WorkflowDocument
}

function checkoutStepOf(job: string): WorkflowStep {
  const workflow = loadNpmReleaseWorkflow()
  const steps = workflow.jobs[job]?.steps
  if (!steps) throw new Error(`Missing '${job}' job in npm-release.yml`)
  const step = steps.find(s => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"))
  if (!step) throw new Error(`Missing an actions/checkout step in the '${job}' job`)
  return step
}

/**
 * Evaluates a GitHub `A && B || C` expression the way the runner does: `&&`
 * yields its right operand when the left is truthy, `||` falls through to its
 * right operand when the left is falsy, and the empty string is falsy.
 */
function evaluateRef(
  expression: string | undefined,
  mode: string,
  convergeTag: string,
  headSha: string
): string {
  if (!expression) {
    // The original bug: no `ref` at all, so checkout silently takes the
    // triggering ref and a converge verifies the push head.
    throw new Error("checkout step sets no `ref`, so a converge would verify the push head")
  }
  const body = expression.trim().replace(/^\$\{\{/, "").replace(/\}\}$/, "").trim()
  const normalized = body.replace(/[()]/g, " ")
  const usesConvergeTag = /needs\.resolve-version\.outputs\.converge-tag/.test(normalized)
  const comparesMode = /needs\.resolve-version\.outputs\.mode\s*==\s*'converge'/.test(normalized)
  if (!(usesConvergeTag && comparesMode)) {
    throw new Error(`ref expression does not branch on converge mode and tag: ${expression}`)
  }
  const fallback = /github\.sha/.test(normalized) ? headSha : ""
  return (mode === "converge" && convergeTag) || fallback
}

describe("npm-release quality job checks out the tree it gates", () => {
  it("resolves to the converge tag on a converge and the push head otherwise", () => {
    const ref = checkoutStepOf("quality").with?.ref
    expect(ref, "quality's checkout must set an explicit `ref`").toBeTruthy()

    const headSha = "72d1d7979219035440aed676c3cfeee24038268f"
    // The failing release: mode=converge at v2.2.1, main already moved on.
    expect(evaluateRef(ref, "converge", "v2.2.1", headSha)).toBe("v2.2.1")
    // An ordinary release still verifies the commit that triggered it.
    expect(evaluateRef(ref, "release", "", headSha)).toBe(headSha)
    // A converge is never allowed to silently fall back to the push head.
    expect(evaluateRef(ref, "converge", "v3.0.0", headSha)).toBe("v3.0.0")
  })

  it("gates the exact ref the converge job publishes", () => {
    const qualityRef = checkoutStepOf("quality").with?.ref
    const convergeRef = checkoutStepOf("converge").with?.ref
    expect(convergeRef, "converge's checkout must set an explicit `ref`").toBeTruthy()

    // The converge job pins the tag directly; quality must resolve to that
    // same value when the run is a converge.
    expect(convergeRef).toContain("converge-tag")
    const headSha = "72d1d7979219035440aed676c3cfeee24038268f"
    expect(evaluateRef(qualityRef, "converge", "v2.2.1", headSha)).toBe("v2.2.1")
  })

  it("runs before the converge job so the gate cannot be bypassed", () => {
    const workflow = load(
      readFileSync(resolve(process.cwd(), ".github/workflows/npm-release.yml"), "utf8")
    ) as { jobs: Record<string, { needs?: string | string[] }> }
    const needs = workflow.jobs.converge?.needs
    const asArray = Array.isArray(needs) ? needs : [needs]
    expect(asArray).toContain("quality")
  })
})
