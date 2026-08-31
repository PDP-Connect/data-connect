#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { isMainModule } from "./is-main-module.js"

const RESOURCE_BUSY = /resource busy/i
const ROOT_DISK = /^\/dev\/disk\d+$/

function outputOf(result) {
  return [result.stderr, result.stdout].filter(Boolean).join("\n").trim()
}

export function matchingImageDevices(plistDocument, outputPath) {
  const expectedPath = resolve(outputPath)
  const images = Array.isArray(plistDocument?.images)
    ? plistDocument.images
    : []

  return images
    .filter(image => {
      const imagePath = image["image-path"]
      return (
        typeof imagePath === "string" && resolve(imagePath) === expectedPath
      )
    })
    .flatMap(image => image["system-entities"] ?? [])
    .map(entity => entity["dev-entry"])
    .filter(device => typeof device === "string" && ROOT_DISK.test(device))
}

function detachMatchingImages({ outputPath, run }) {
  const info = run("hdiutil", ["info", "-plist"], { encoding: "utf8" })
  if (info.status !== 0 || !info.stdout) return

  const converted = run("plutil", ["-convert", "json", "-o", "-", "-"], {
    encoding: "utf8",
    input: info.stdout,
  })
  if (converted.status !== 0 || !converted.stdout) return

  let document
  try {
    document = JSON.parse(converted.stdout)
  } catch {
    return
  }

  for (const device of new Set(matchingImageDevices(document, outputPath))) {
    run("hdiutil", ["detach", device], { encoding: "utf8" })
  }
}

export async function createMacosDmg({
  volumeName,
  sourceFolder,
  outputPath,
  maxAttempts = 3,
  run = spawnSync,
  remove = rmSync,
  sleep = delay => new Promise(resolveDelay => setTimeout(resolveDelay, delay)),
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = run(
      "hdiutil",
      [
        "create",
        "-volname",
        volumeName,
        "-srcfolder",
        sourceFolder,
        "-ov",
        "-format",
        "UDZO",
        outputPath,
      ],
      { encoding: "utf8" }
    )
    if (result.status === 0) return

    const output = outputOf(result)
    if (!RESOURCE_BUSY.test(output) || attempt === maxAttempts) {
      throw new Error(
        `hdiutil create failed: ${output || `exit ${result.status}`}`
      )
    }

    detachMatchingImages({ outputPath, run })
    remove(outputPath, { force: true })
    await sleep(attempt * 2_000)
  }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1] || null
}

async function main(argv) {
  const volumeName = optionValue(argv, "--volume-name")
  const sourceFolder = optionValue(argv, "--source-folder")
  const outputPath = optionValue(argv, "--output")
  if (!volumeName || !sourceFolder || !outputPath) {
    throw new Error(
      "Usage: --volume-name <name> --source-folder <path> --output <path>"
    )
  }
  await createMacosDmg({ volumeName, sourceFolder, outputPath })
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
