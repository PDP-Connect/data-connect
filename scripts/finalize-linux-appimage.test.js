// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  findPersonalServerDist,
  findResourceRoot,
  restorePersonalServer,
  restoreReferenceStacks,
} from "./finalize-linux-appimage.js"

test("restores the personal-server runtime tree in a nested AppDir", () => {
  const root = mkdtempSync(
    join(homedir(), ".tmp", "finalize-linux-appimage-test-")
  )
  try {
    const source = join(root, "source-dist")
    const appDir = join(root, "DataConnect.AppDir")
    const destination = join(
      appDir,
      "usr",
      "lib",
      "DataConnect",
      "personal-server",
      "dist"
    )
    mkdirSync(join(source, "node_modules", "package"), { recursive: true })
    mkdirSync(join(destination, "node_modules"), { recursive: true })
    writeFileSync(join(source, "personal-server"), "pristine binary")
    writeFileSync(
      join(source, "node_modules", "package", "index.js"),
      "module exports"
    )
    chmodSync(join(source, "personal-server"), 0o755)
    writeFileSync(join(destination, "personal-server"), "patched binary")

    assert.equal(findPersonalServerDist(appDir), destination)
    assert.equal(restorePersonalServer(appDir, source), destination)
    assert.equal(
      readFileSync(join(destination, "personal-server"), "utf8"),
      "pristine binary"
    )
    assert.ok(statSync(join(destination, "personal-server")).mode & 0o111)
    assert.equal(
      readFileSync(
        join(destination, "node_modules", "package", "index.js"),
        "utf8"
      ),
      "module exports"
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("restores both reference-stack roots in a nested AppDir", () => {
  const root = mkdtempSync(
    join(homedir(), ".tmp", "finalize-linux-reference-stack-test-")
  )
  try {
    const source = join(root, "staged-reference-stack")
    const appDir = join(root, "DataConnect.AppDir")
    const appResources = join(
      appDir,
      "usr",
      "lib",
      "DataConnect",
      "reference-stack"
    )

    for (const name of ["ri", "console"]) {
      mkdirSync(join(source, name), { recursive: true })
      writeFileSync(join(source, name, "manifest.json"), `${name} manifest`)
      mkdirSync(join(appResources, name), { recursive: true })
      writeFileSync(join(appResources, name, "stale.txt"), "stale")
    }

    assert.equal(
      findResourceRoot(appDir, "reference-stack/ri"),
      join(appResources, "ri")
    )
    const destinations = restoreReferenceStacks(appDir, source)

    assert.deepEqual(destinations, {
      ri: join(appResources, "ri"),
      console: join(appResources, "console"),
    })
    for (const name of ["ri", "console"]) {
      assert.equal(
        readFileSync(join(appResources, name, "manifest.json"), "utf8"),
        `${name} manifest`
      )
      assert.equal(existsSync(join(appResources, name, "stale.txt")), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
