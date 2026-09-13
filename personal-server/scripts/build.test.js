// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, describe, it } from "node:test"
import {
  assertImportsStayInsideDist,
  listProductionDependencyPaths,
  resolveExportsSubpath,
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

// The `exports` shapes here are copied from `@opendatalabs/vana-sdk`, the
// package whose import-only subpaths made this resolver necessary.
describe("import-only export resolution", () => {
  it("prefers the browser artifact the specifier already asked for", () => {
    assert.equal(
      resolveExportsSubpath(
        {
          "./browser": {
            types: "./dist/index.browser.d.ts",
            import: "./dist/index.browser.js",
          },
        },
        "./browser"
      ),
      "./dist/index.browser.js"
    )
  })

  it("never answers with a `types` entry", () => {
    assert.equal(
      resolveExportsSubpath({ "./x": { types: "./x.d.ts" } }, "./x"),
      null
    )
  })

  it("substitutes the wildcard match into the target", () => {
    assert.equal(
      resolveExportsSubpath(
        { "./*": { import: "./dist/*.js" } },
        "./protocol/personal-server-registration"
      ),
      "./dist/protocol/personal-server-registration.js"
    )
  })

  // Key order in the object must not decide this; the longer prefix does.
  it("lets a longer pattern win over a shorter one regardless of key order", () => {
    const exports = {
      "./*": { import: "./dist/*.js" },
      "./direct/*": { import: "./dist/direct/*.js" },
    }
    assert.equal(
      resolveExportsSubpath(exports, "./direct/escrow-payment"),
      "./dist/direct/escrow-payment.js"
    )
  })

  it("treats an explicit null condition as a blocked subpath", () => {
    assert.equal(
      resolveExportsSubpath(
        { "./server-only": { browser: null, import: "./dist/server-only.js" } },
        "./server-only"
      ),
      null
    )
  })

  it("reports an unmapped subpath rather than guessing a file", () => {
    assert.equal(
      resolveExportsSubpath({ ".": { import: "./dist/index.js" } }, "./missing"),
      null
    )
  })
})

// The regression this whole change exists for: the build emitted
// `../../../../../node_modules/@opendatalabs/vana-sdk/dist/index.browser.js`,
// which points at the build machine and at nothing on any other host.
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
