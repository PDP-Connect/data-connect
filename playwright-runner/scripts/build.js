/**
 * Build script for playwright-runner
 *
 * Creates standalone binaries with bundled Node.js and copies Playwright browsers.
 */

import { execSync } from "child_process"
import {
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
  readdirSync,
  statSync,
  readFileSync,
} from "fs"
import { join, dirname, isAbsolute, posix, resolve, win32 } from "path"
import { fileURLToPath } from "url"
import { homedir, platform, arch } from "os"
import { chromium } from "playwright"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const DIST = join(ROOT, "dist")

// Determine current platform
const PLATFORM = platform()
const ARCH = arch()

function log(msg) {
  console.log(`[build] ${msg}`)
}

function exec(cmd, opts = {}) {
  log(`Running: ${cmd}`)
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts })
}

// Get Playwright browser path
function getPlaywrightBrowserPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH
  }
  // Playwright stores browsers in different locations depending on OS:
  // - macOS: ~/Library/Caches/ms-playwright
  // - Linux: ~/.cache/ms-playwright
  // - Windows: %LOCALAPPDATA%\ms-playwright
  if (PLATFORM === "darwin") {
    return join(homedir(), "Library", "Caches", "ms-playwright")
  } else if (PLATFORM === "win32") {
    return join(process.env.LOCALAPPDATA || "", "ms-playwright")
  }
  return join(homedir(), ".cache", "ms-playwright")
}

// Find the chromium directory
function findChromiumDir(basePath) {
  if (!existsSync(basePath)) {
    return null
  }

  const entries = readdirSync(basePath)
  const chromiumDir = entries.find(e => e.startsWith("chromium-"))

  if (chromiumDir) {
    return join(basePath, chromiumDir)
  }
  return null
}

export function getBrowserDirectoryName(browserPath, platformName = PLATFORM) {
  return platformName === "win32"
    ? win32.basename(browserPath)
    : posix.basename(browserPath)
}

function findChromiumExecutable(chromiumDir) {
  const candidates = {
    darwin: [
      join(
        chromiumDir,
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing"
      ),
      join(
        chromiumDir,
        "chrome-mac-x64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing"
      ),
      join(
        chromiumDir,
        "chrome-mac",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing"
      ),
      join(
        chromiumDir,
        "chrome-mac-arm64",
        "Chromium.app",
        "Contents",
        "MacOS",
        "Chromium"
      ),
      join(
        chromiumDir,
        "chrome-mac",
        "Chromium.app",
        "Contents",
        "MacOS",
        "Chromium"
      ),
    ],
    linux: [
      join(chromiumDir, "chrome-linux64", "chrome"),
      join(chromiumDir, "chrome-linux", "chrome"),
    ],
    win32: [
      join(chromiumDir, "chrome-win64", "chrome.exe"),
      join(chromiumDir, "chrome-win", "chrome.exe"),
    ],
  }[PLATFORM]
  return candidates?.find(existsSync) || null
}

export function supportsBrowserProvisioning(platformName, osRelease = "") {
  if (platformName !== "linux") return true

  const id = /^ID="?([^"\n]+)"?$/m.exec(osRelease)?.[1]
  const version = /^VERSION_ID="?([^"\n]+)"?$/m.exec(osRelease)?.[1]
  return (
    (id === "ubuntu" && ["22.04", "24.04"].includes(version)) ||
    (id === "debian" && version === "12")
  )
}

function hostSupportsBrowserProvisioning() {
  if (PLATFORM !== "linux") return true
  const osRelease = existsSync("/etc/os-release")
    ? readFileSync("/etc/os-release", "utf8")
    : ""
  return supportsBrowserProvisioning(PLATFORM, osRelease)
}

// Get pkg target for current platform
function getPkgTarget() {
  const nodeVersion = "node22"

  if (PLATFORM === "darwin") {
    return ARCH === "arm64"
      ? `${nodeVersion}-macos-arm64`
      : `${nodeVersion}-macos-x64`
  } else if (PLATFORM === "win32") {
    return `${nodeVersion}-win-x64`
  } else {
    return `${nodeVersion}-linux-x64`
  }
}

// Get output binary name
function getOutputName() {
  const base = "playwright-runner"
  if (PLATFORM === "win32") {
    return `${base}.exe`
  }
  return base
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : argv[index + 1] || null
}

export function parseBuildOptions(argv) {
  const isLean = argv.includes("--lean")
  const requireBrowser = argv.includes("--require-browser")
  if (isLean && requireBrowser) {
    throw new Error("--lean and --require-browser cannot be used together")
  }

  const target = optionValue(argv, "--target") || getPkgTarget()
  const configuredOutput = optionValue(argv, "--output")
  const outputPath = configuredOutput
    ? isAbsolute(configuredOutput)
      ? configuredOutput
      : resolve(ROOT, configuredOutput)
    : join(DIST, getOutputName())

  return { isLean, outputPath, requireBrowser, target }
}

async function build(options) {
  const { isLean, outputPath, requireBrowser, target } = options

  log(`Starting ${isLean ? "LEAN " : ""}build...`)
  if (isLean) {
    log(
      "Lean mode: Chromium will NOT be bundled (downloaded on-demand at runtime)"
    )
  } else if (!requireBrowser) {
    log(
      "Browser provisioning skipped. A cached browser will be bundled when available."
    )
  }

  // Clean dist
  if (existsSync(DIST)) {
    rmSync(DIST, { recursive: true })
  }
  mkdirSync(DIST, { recursive: true })

  if (requireBrowser && !findChromiumDir(getPlaywrightBrowserPath())) {
    if (!hostSupportsBrowserProvisioning()) {
      throw new Error(
        "This host is not supported for Playwright browser provisioning. Use a supported release runner or pre-populate PLAYWRIGHT_BROWSERS_PATH."
      )
    }
    log("Provisioning the Playwright browser required by release artifacts...")
    exec("npx playwright install chromium")
  }

  // Build with pkg
  log(`Building for target: ${target}`)
  exec(
    `npx pkg index.cjs -t ${target} -o "${outputPath}" --no-bytecode --public-packages '*' --public`
  )

  // Copy Playwright browser (only for non-lean builds)
  if (!isLean) {
    const browserSrc = getPlaywrightBrowserPath()
    const chromiumDir = findChromiumDir(browserSrc)

    if (chromiumDir) {
      const browserDest = join(DIST, "browsers")
      mkdirSync(browserDest, { recursive: true })

      const chromiumDirName = getBrowserDirectoryName(chromiumDir)
      const destPath = join(browserDest, chromiumDirName)

      log(`Copying Chromium from ${chromiumDir} to ${destPath}...`)
      cpSync(chromiumDir, destPath, { recursive: true })

      log("Browser copied successfully")
      if (requireBrowser) {
        const executablePath = findChromiumExecutable(destPath)
        if (!executablePath) {
          throw new Error(
            "The copied Chromium directory does not contain a platform browser executable"
          )
        }
        log("Launching the packaged browser for a compatibility smoke test...")
        const browser = await chromium.launch({
          executablePath,
          headless: true,
        })
        await browser.close()
        log("Packaged browser smoke test passed")
      }
    } else {
      if (requireBrowser) {
        throw new Error(
          "Playwright reported a successful install but Chromium was not found in its cache"
        )
      }
      log(
        "No cached Chromium found. The app will use a system browser or provision one at runtime."
      )
    }
  } else {
    log("Skipping browser copy (lean build)")
  }

  // Sign the binary on macOS (required for it to run after being copied)
  if (PLATFORM === "darwin") {
    log("Signing binary for macOS...")
    try {
      execSync(`codesign --force --sign - "${outputPath}"`, {
        stdio: "inherit",
      })
      log("Binary signed successfully")
    } catch (e) {
      log(
        "Warning: Failed to sign binary (may cause issues running the binary)"
      )
    }
  }

  log("Build complete!")
  log(`Output: ${DIST}`)

  // List output
  const files = readdirSync(DIST)
  log("Contents:")
  for (const file of files) {
    const stat = statSync(join(DIST, file))
    const size = stat.isDirectory()
      ? "dir"
      : `${(stat.size / 1024 / 1024).toFixed(1)}MB`
    log(`  ${file} (${size})`)
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  build(parseBuildOptions(process.argv.slice(2))).catch(err => {
    console.error("Build failed:", err)
    process.exit(1)
  })
}
