// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process"
import { existsSync, fstatSync, lstatSync, readlinkSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

function rootMounts() {
  // Construct the namespace root instead of binding an unmapped host root.
  // Home safety still checks real ownership and permissions at every ancestor.
  const mounts = ["--dev", "/dev"]
  for (const name of [
    "usr",
    "etc",
    "opt",
    "var",
    "run",
    "sys",
    "bin",
    "sbin",
    "lib",
    "lib64",
  ]) {
    const path = `/${name}`
    if (!existsSync(path)) continue
    if (lstatSync(path).isSymbolicLink())
      mounts.push("--symlink", readlinkSync(path), path)
    else mounts.push("--ro-bind", path, path)
  }
  const home = homedir(),
    ancestors = []
  for (let path = dirname(home); path !== "/"; path = dirname(path))
    ancestors.unshift(path)
  for (const path of ancestors) mounts.push("--dir", path)
  mounts.push("--bind", home, home)
  return mounts
}

const args = process.argv.slice(2)
if (args.shift() !== "--" || !args.length)
  throw new Error("An explicit test command is required")
const parent = join(homedir(), ".tmp", "ra")
await mkdir(parent, { recursive: true, mode: 0o700 })
const scratch = await mkdtemp(join(parent, "browser-"))
let channel = "ignore"
try {
  if (fstatSync(3).isFIFO() || fstatSync(3).isSocket()) channel = 3
} catch {}
try {
  const child = spawn(
    "bwrap",
    [
      ...rootMounts(),
      "--die-with-parent",
      "--unshare-net",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--bind",
      scratch,
      "/scratch",
      "--chdir",
      process.cwd(),
      "--",
      ...args,
    ],
    {
      stdio: ["inherit", "inherit", "inherit", channel],
      env: {
        ...process.env,
        TEST_TMPDIR: "/scratch",
        TMPDIR: "/scratch",
        TEST_SANDBOX_RUN_ISOLATE: "full",
        TEST_SANDBOX_RUN_NET: "none",
      },
    }
  )
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) =>
      resolve(code ?? (signal === "SIGINT" ? 130 : 143))
    )
  })
  process.exitCode = code
} finally {
  await rm(scratch, { recursive: true, force: true })
}
