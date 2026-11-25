// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  captureExistingClientContract,
  writeContract,
} from "../test/helpers/mcp-existing-client-session.ts"
import { assertMcpBaseProvenance } from "../test/helpers/mcp-existing-client-provenance.ts"

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/mcp-existing-client-contract.json"
)
assertMcpBaseProvenance(join(dirname(fileURLToPath(import.meta.url)), "../.."))
const contract = await captureExistingClientContract()
writeContract(fixture, contract)
console.log(
  `Wrote ${fixture}; review the diff and include a justification line in the commit body before updating this golden contract.`
)
