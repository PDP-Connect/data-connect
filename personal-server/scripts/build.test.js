// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import {
  assertImportsStayInsideDist,
  listProductionDependencyPaths,
  resolveImportOnlyExport,
} from "./build.js"

describe("personal-server production dependency listing", () => {
  it("runs npm through Node and parses Windows dependency paths", () => {
    let invocation
    const spawn = (...args) => {
      invocation = args
      return {
        status: 0,
        stdout: [
          "D:\\a\\data-connect\\personal-server",
          "D:\\a\\data-connect\\personal-server\\node_modules\\hono",
          "D:\\a\\data-connect\\personal-server\\node_modules\\zod",
          "",
        ].join("\r\n"),
        stderr: "",
      }
    }

    const paths = listProductionDependencyPaths({
      root: "D:\\a\\data-connect\\personal-server",
      platformName: "win32",
      nodePath: "C:\\hostedtoolcache\\node.exe",
      npmCliPath: "C:\\hostedtoolcache\\npm\\bin\\npm-cli.js",
      spawn,
    })

    assert.deepEqual(invocation, [
      "C:\\hostedtoolcache\\node.exe",
      [
        "C:\\hostedtoolcache\\npm\\bin\\npm-cli.js",
        "ls",
        "--omit=dev",
        "--all",
        "--parseable",
      ],
      {
        cwd: "D:\\a\\data-connect\\personal-server",
        encoding: "utf8",
        shell: false,
      },
    ])
    assert.deepEqual(paths, [
      "D:\\a\\data-connect\\personal-server\\node_modules\\hono",
      "D:\\a\\data-connect\\personal-server\\node_modules\\zod",
    ])
  })

  it("reports process launch errors instead of an undefined message", () => {
    assert.throws(
      () =>
        listProductionDependencyPaths({
          spawn: () => ({
            status: null,
            stdout: undefined,
            stderr: undefined,
            error: new Error("spawn npm ENOENT"),
          }),
        }),
      /Failed to list production dependencies: spawn npm ENOENT/
    )
  })
})

// Export resolution is delegated to Node, so these tests check *agreement with
// Node* rather than the behaviour of a second implementation.
//
// Each case builds a real package on disk with a valid, import-only export map,
// imports the specifier for real to learn Node's answer, then asks the build's
// resolver the same question. The previous hand-rolled resolver disagreed with
// Node on four of these; the last two are positive controls it already got
// right, and they must keep passing.
describe("import-only export resolution agrees with Node", () => {
  const roots = []
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  const FILES = [
    "node.js", "browser.js", "default.js", "b.js", "index.js",
    "a-thing.js", "star-thing.js", "long-m.js", "short-m.js.js",
    "qnode.js", "qbrowser.js",
  ]

  /** Build a package with `exports`, then return Node's answer and the build's. */
  async function bothAnswers(exports, specifier) {
    const root = mkdtempSync(join(tmpdir(), "export-map-"))
    roots.push(root)
    const pkg = join(root, "node_modules", "pkg")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "pkg", version: "1.0.0", type: "module", exports })
    )
    for (const file of FILES) {
      writeFileSync(join(pkg, file), `export const which = ${JSON.stringify(file)}\n`)
    }

    const importer = join(root, "importer.mjs")
    writeFileSync(importer, `export { which } from ${JSON.stringify(specifier)}\n`)

    let node
    try {
      node = (await import(pathToFileURL(importer).href)).which
    } catch (error) {
      node = `ERR:${error.code}`
    }

    let build
    try {
      build = basename(resolveImportOnlyExport(specifier, importer, new Map()))
    } catch {
      build = "ERR:refused"
    }
    return { node, build }
  }

  // Defect 1: `node` applies to these files and outranks `browser`. The fixed
  // condition list never contained it, so the browser artifact was chosen.
  it("honours an applicable `node` condition over `browser`", async () => {
    const { node, build } = await bothAnswers(
      { "./x": { node: "./node.js", browser: "./browser.js", default: "./default.js" } },
      "pkg/x"
    )
    assert.equal(node, "node.js")
    assert.equal(build, node)
  })

  // Defect 2: conditions resolve in the order the *author* wrote them.
  it("respects author condition order rather than a fixed preference list", async () => {
    const { node, build } = await bothAnswers(
      { "./y": { default: "./default.js", browser: "./browser.js" } },
      "pkg/y"
    )
    assert.equal(node, "default.js")
    assert.equal(build, node)
  })

  // Defect 3: the same two faults one level down, inside a nested object.
  it("applies conditions correctly inside a nested condition object", async () => {
    const { node, build } = await bothAnswers(
      { "./q": { import: { node: "./qnode.js", browser: "./qbrowser.js" } } },
      "pkg/q"
    )
    assert.equal(node, "qnode.js")
    assert.equal(build, node)
  })

  // Defect 4: specificity compared prefix length only, so with equal prefixes
  // the winner depended on key order instead of on the longer pattern.
  it("orders wildcard specificity by the whole pattern, not the prefix alone", async () => {
    const { node, build } = await bothAnswers(
      { "./p/*": { import: "./short-*.js" }, "./p/*.js": { import: "./long-*.js" } },
      "pkg/p/m.js"
    )
    assert.equal(node, "long-m.js")
    assert.equal(build, node)
  })

  it("positive control: resolves a plain import-only subpath", async () => {
    const { node, build } = await bothAnswers(
      { "./b": { types: "./b.d.ts", import: "./b.js" } },
      "pkg/b"
    )
    assert.equal(node, "b.js")
    assert.equal(build, node)
  })

  it("positive control: resolves an import-only package root", async () => {
    const { node, build } = await bothAnswers({ ".": { import: "./index.js" } }, "pkg")
    assert.equal(node, "index.js")
    assert.equal(build, node)
  })

  // Refusal, not a guess: a subpath Node will not resolve must fail the build.
  it("refuses a subpath Node does not export rather than answering anyway", async () => {
    const { node, build } = await bothAnswers({ "./r": { require: "./r.cjs" } }, "pkg/r")
    assert.equal(node, "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED")
    assert.equal(build, "ERR:refused")
  })
})

describe("artifact boundary", () => {
  const roots = []
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  function distWith(relativePath, contents) {
    const root = mkdtempSync(join(tmpdir(), "dist-boundary-"))
    roots.push(root)
    const file = join(root, relativePath)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents)
    return { root, file }
  }

  it("rejects an import that climbs out of the dist", () => {
    const { root, file } = distWith(
      "node_modules/@opendatalabs/personal-server-ts-core/dist/client.js",
      'import { buildWeb3SignedHeader } from "../../../../../node_modules/@opendatalabs/vana-sdk/dist/index.browser.js";\n'
    )
    assert.throws(() => assertImportsStayInsideDist([file], root), {
      message: /1 import\(s\).*resolve outside/s,
    })
    assert.throws(() => assertImportsStayInsideDist([file], root), {
      message: /client\.js:1 imports \.\.\/\.\.\/\.\.\/\.\.\/\.\.\/node_modules/,
    })
  })

  it("accepts the sibling-package path a self-contained artifact uses", () => {
    const { root, file } = distWith(
      "node_modules/@opendatalabs/personal-server-ts-core/dist/client.js",
      'import { buildWeb3SignedHeader } from "../../vana-sdk/dist/index.browser.js";\n'
    )
    assert.doesNotThrow(() => assertImportsStayInsideDist([file], root))
  })

  // Bare specifiers are Node's job to resolve out of `dist/node_modules` at
  // runtime; this check is only about the relative paths the build writes.
  it("ignores bare specifiers and non-import lines", () => {
    const { root, file } = distWith(
      "node_modules/@opendatalabs/personal-server-ts-core/dist/client.js",
      [
        'import hono from "hono";',
        '// import x from "../../../../../elsewhere.js";',
        'const from = "../../../../../not-an-import.js";',
        "",
      ].join("\n")
    )
    assert.doesNotThrow(() => assertImportsStayInsideDist([file], root))
  })

  it("names every escaping import, not just the first", () => {
    const { root, file } = distWith(
      "node_modules/@opendatalabs/personal-server-ts-core/dist/client.js",
      [
        'import a from "../../../../../node_modules/one/index.js";',
        'export { b } from "../../../../../node_modules/two/index.js";',
        "",
      ].join("\n")
    )
    assert.throws(() => assertImportsStayInsideDist([file], root), {
      message: /2 import\(s\)/,
    })
  })
})
