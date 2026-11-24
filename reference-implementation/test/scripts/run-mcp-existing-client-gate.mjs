// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const files = [
  "test/mcp-existing-client-gate.test.ts",
  "test/mcp-existing-client-audience-migration.test.ts",
  "test/mcp-stored-id-resolution.test.ts",
]
const inventoryPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/mcp-existing-client-gate-inventory.json"
)
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"))
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-reporter=tap", ...files],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
)
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
process.stdout.write(output)

const failures = []
const declared = []
const observed = new Map()
for (const line of output.split("\n")) {
  const subtest = line.match(/^# Subtest: (.+)$/)
  if (subtest) declared.push(subtest[1])
  const completed = line.match(
    /^\s*(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO)\s+(.+))?$/
  )
  if (completed)
    observed.set(completed[2], {
      status: completed[1],
      marker: completed[3],
      reason: completed[4] ?? "",
      line: line.trim(),
    })
  if (/\s#\s+(?:SKIP|TODO)\b/.test(line)) {
    const result = completed
    const pending = inventory.pending.find(entry => entry.name === result?.[2])
    const expectedDependency =
      pending?.dependency === "identity-lane P2 worktree"
        ? "WAITING FOR IDENTITY-LANE P2"
        : pending?.dependency === "identity-lane P4 worktree"
          ? "WAITING FOR IDENTITY-LANE P4"
          : ""
    if (
      !pending ||
      !expectedDependency ||
      !result?.[4]?.includes(expectedDependency)
    )
      failures.push(`unexpected skipped/todo gate scenario: ${line.trim()}`)
  }
  if (/^\s*not ok\s+\d+\s+-/.test(line)) failures.push(line.trim())
}
const expectedNames = [
  ...inventory.active,
  ...inventory.pending.map(entry => entry.name),
].sort()
if (JSON.stringify([...declared].sort()) !== JSON.stringify(expectedNames)) {
  failures.push(
    `scenario inventory mismatch: expected ${expectedNames.length} tests (${expectedNames.join(" | ")}), observed ${declared.length} (${declared.join(" | ")})`
  )
}
const tapTestCount = Number(output.match(/^# tests (\d+)$/m)?.[1] ?? -1)
if (tapTestCount !== expectedNames.length)
  failures.push(
    `TAP test count mismatch: expected ${expectedNames.length}, observed ${tapTestCount}`
  )
for (const name of inventory.active) {
  const result = observed.get(name)
  if (!result) failures.push(`active scenario was not executed: ${name}`)
  else if (result.status !== "ok" || result.marker)
    failures.push(`active scenario did not pass: ${result.line}`)
}
for (const pending of inventory.pending) {
  const result = observed.get(pending.name)
  if (!result) failures.push(`pending scenario is missing: ${pending.name}`)
  else if (
    result.marker &&
    !(
      result.reason.includes("WAITING FOR IDENTITY-LANE P2") ||
      result.reason.includes("WAITING FOR IDENTITY-LANE P4")
    )
  )
    failures.push(`pending scenario has an unapproved skip: ${result.line}`)
}
if (inventory.pending.length) {
  process.stdout.write("\nPENDING GATE SCENARIOS:\n")
  for (const scenario of inventory.pending)
    process.stdout.write(
      `- ${scenario.name} — blocked by ${scenario.dependency}\n`
    )
}
if (inventory.documentedTodo.length) {
  process.stdout.write("\nDOCUMENTED TODO COVERAGE:\n")
  for (const scenario of inventory.documentedTodo)
    process.stdout.write(`- ${scenario.name} — ${scenario.dependency}\n`)
}
if (failures.length) {
  process.stderr.write("\nGATE HARNESS FAILURES:\n")
  for (const failure of failures) process.stderr.write(`- ${failure}\n`)
  process.exitCode = 1
} else if (result.status !== 0) {
  process.exitCode = result.status ?? 1
}
