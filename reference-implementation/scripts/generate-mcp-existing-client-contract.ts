// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  captureExistingClientContract,
  writeContract,
} from "../test/helpers/mcp-existing-client-session.ts"

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/mcp-existing-client-contract.json"
)
const baseRevision = "3282ac2f5e4687419bf391c2294d2118dd63fd7c"
const currentRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim()
if (currentRevision !== baseRevision) {
  throw new Error(
    `Contract refresh requires base ${baseRevision}; current revision is ${currentRevision}`
  )
}
const contract = await captureExistingClientContract()
writeContract(fixture, contract)
console.log(
  `Wrote ${fixture}; review the diff and include a justification line in the commit body before updating this golden contract.`
)
