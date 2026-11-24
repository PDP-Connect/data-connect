// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { load } from "js-yaml"
import { describe, expect, it } from "vitest"

/**
 * `npm ci` runs dependency lifecycle scripts. onnxruntime-node's install script
 * (node ./script/install) is one of them, and on linux/x64 its default manifest
 * is the CUDA 12 provider package, which it downloads from nuget.org. Hosted
 * runners are CPU-only, that download timed out (`AggregateError [ETIMEDOUT]`
 * connecting to api.nuget.org) and failed `npm ci` five times on 2026-10-21,
 * and nothing in this repo selects the CUDA execution provider -- the CPU
 * binding ships inside the package tarball.
 *
 * Every workflow that lets npm run lifecycle scripts therefore sets
 * ONNXRUNTIME_NODE_INSTALL=skip (onnxruntime-node's own supported switch, read
 * by script/install-utils.js). This test keeps that true for workflows added
 * later, so a new lane cannot quietly reintroduce the download.
 */

const workflowDir = resolve(process.cwd(), ".github/workflows")

type WorkflowEnv = Record<string, unknown> | undefined
type WorkflowStep = { name?: string; run?: string; env?: WorkflowEnv }
type WorkflowJob = { env?: WorkflowEnv; steps?: WorkflowStep[] }
type Workflow = { env?: WorkflowEnv; jobs?: Record<string, WorkflowJob> }

function workflowPaths(): string[] {
  return readdirSync(workflowDir)
    .filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map(name => join(workflowDir, name))
    .sort()
}

/** True when a `run` script installs dependencies without --ignore-scripts. */
function runsInstallLifecycleScripts(run: string): boolean {
  const installs = /\bnpm (?:ci|install)\b/.test(run)
  return installs && !/--ignore-scripts\b/.test(run)
}

function installSkipValue(
  workflow: Workflow,
  job: WorkflowJob,
  step: WorkflowStep
): unknown {
  return (
    step.env?.ONNXRUNTIME_NODE_INSTALL ??
    job.env?.ONNXRUNTIME_NODE_INSTALL ??
    workflow.env?.ONNXRUNTIME_NODE_INSTALL
  )
}

describe("CI installs skip onnxruntime-node's CUDA download", () => {
  // The scan is only meaningful if it still finds installs to check.
  it("finds the npm ci steps this guard covers", () => {
    const covered: string[] = []
    for (const path of workflowPaths()) {
      const workflow = load(readFileSync(path, "utf8")) as Workflow
      for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
        for (const [index, step] of (job.steps ?? []).entries()) {
          if (step.run && runsInstallLifecycleScripts(step.run)) {
            covered.push(`${path}:${jobId}:${step.name ?? index}`)
          }
        }
      }
    }
    expect(covered.length).toBeGreaterThan(0)
    expect(
      covered.some(entry => entry.includes("reference-implementation.yml"))
    ).toBe(true)
  })

  it("sets ONNXRUNTIME_NODE_INSTALL=skip wherever npm runs lifecycle scripts", () => {
    const offenders: string[] = []
    for (const path of workflowPaths()) {
      const workflow = load(readFileSync(path, "utf8")) as Workflow
      for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
        for (const [index, step] of (job.steps ?? []).entries()) {
          if (!step.run || !runsInstallLifecycleScripts(step.run)) continue
          if (installSkipValue(workflow, job, step) !== "skip") {
            offenders.push(
              `${path.slice(workflowDir.length + 1)} job ${jobId} step ${step.name ?? index}`
            )
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
