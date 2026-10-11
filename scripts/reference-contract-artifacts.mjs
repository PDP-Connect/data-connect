#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { generateDocs } from "@pdpp/reference-contract/docs"
import { generateOpenApi } from "@pdpp/reference-contract/openapi"

const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error(
    "Usage: node scripts/reference-contract-artifacts.mjs [--check]"
  )
}
const check = args[0] === "--check"
const docs = generateDocs()
const artifacts = [
  [
    "openapi/reference-public.openapi.json",
    `${JSON.stringify(generateOpenApi(), null, 2)}\n`,
  ],
  [
    "openapi/reference-full.openapi.json",
    `${JSON.stringify(generateOpenApi({ includeReference: true }), null, 2)}\n`,
  ],
  ["docs/generated/reference-routes.md", `${docs.routes.trimEnd()}\n`],
  [
    "docs/generated/reference-ref-routes.md",
    `${docs.referenceRoutes.trimEnd()}\n`,
  ],
  ["docs/generated/query-cookbook.md", `${docs.cookbook.trimEnd()}\n`],
]

for (const [path, generated] of artifacts) {
  const url = new URL(`../reference-implementation/${path}`, import.meta.url)
  if (check) {
    const current = await readFile(url, "utf8")
    if (current !== generated) {
      throw new Error(
        `Stale contract artifact: ${path}. Run npm run reference-contract:generate.`
      )
    }
  } else {
    await mkdir(dirname(fileURLToPath(url)), { recursive: true })
    await writeFile(url, generated)
  }
}
process.stdout.write(
  check
    ? "Contract artifacts are current.\n"
    : "Generated contract artifacts.\n"
)
