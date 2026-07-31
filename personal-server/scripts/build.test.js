import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { listProductionDependencyPaths } from "./build.js"

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
