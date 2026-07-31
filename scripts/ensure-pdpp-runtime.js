import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runtimeRoot = join(root, "pdpp-runtime")
const required = ["p-queue", "patchright"].map(name =>
  join(runtimeRoot, "node_modules", name, "package.json")
)
const stampPath = join(runtimeRoot, ".install-stamp")
const stamp = createHash("sha256")
  .update(readFileSync(join(runtimeRoot, "package.json")))
  .update(readFileSync(join(runtimeRoot, "package-lock.json")))
  .digest("hex")

if (
  required.every(existsSync) &&
  existsSync(stampPath) &&
  readFileSync(stampPath, "utf8").trim() === stamp
)
  process.exit(0)

const install = spawnSync("npm", ["ci", "--ignore-scripts"], {
  cwd: runtimeRoot,
  stdio: "inherit",
})
if (install.status === 0) writeFileSync(stampPath, `${stamp}\n`)
process.exit(install.status ?? 1)
