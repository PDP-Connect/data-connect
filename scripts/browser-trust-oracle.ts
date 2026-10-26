#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Offline DER containment is a release HOLD inventory, NOT proof that a browser
// trusts a root. Runtime distrust, policy, CT and revocation are separate gates.
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

export interface Certificate {
  readonly name: string
  readonly sha256: string
  readonly pem: string
  readonly sourceURL: string
}
export interface Hold extends Certificate {
  readonly reason: string
  readonly reentry: string
}
export interface Inventory {
  readonly positiveControl: Certificate
  readonly holds: readonly Hold[]
}
export const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex")

export function certificateDER(certificate: Certificate): Buffer {
  if (
    !certificate ||
    typeof certificate.name !== "string" ||
    !certificate.name.trim() ||
    typeof certificate.sourceURL !== "string" ||
    !certificate.sourceURL.startsWith("https://") ||
    typeof certificate.pem !== "string" ||
    !/^[a-f0-9]{64}$/u.test(certificate.sha256)
  ) {
    throw new Error("invalid certificate inventory entry")
  }
  const match =
    /^-----BEGIN CERTIFICATE-----\s+([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----\s*$/u.exec(
      certificate.pem
    )
  if (!match) throw new Error(`invalid PEM: ${certificate.name}`)
  const encoded = match[1].replace(/\s/gu, "")
  const der = Buffer.from(encoded, "base64")
  if (!der.length || der.toString("base64") !== encoded)
    throw new Error(`invalid DER encoding: ${certificate.name}`)
  if (sha256(der) !== certificate.sha256)
    throw new Error(`sha256 mismatch: ${certificate.name}`)
  return der
}

export function inspectBinary(
  binary: Buffer,
  inventory: Inventory
): {
  ok: boolean
  positiveControl: { name: string; present: boolean }
  holds: { name: string; present: boolean; reentry: string }[]
} {
  if (!inventory || !Array.isArray(inventory.holds))
    throw new Error("invalid holds inventory")
  // Validate every digest even if the control is absent: a malformed inventory
  // must never be mistaken for a resolved hold.
  const control = certificateDER(inventory.positiveControl)
  const holds = inventory.holds.map(hold => {
    if (
      typeof hold.reason !== "string" ||
      !hold.reason.trim() ||
      typeof hold.reentry !== "string" ||
      !hold.reentry.trim()
    ) {
      throw new Error("hold requires reason and reentry")
    }
    return {
      name: hold.name,
      present: binary.includes(certificateDER(hold)),
      reentry: hold.reentry,
    }
  })
  const positiveControl = {
    name: inventory.positiveControl.name,
    present: binary.includes(control),
  }
  return {
    ok: positiveControl.present && holds.every(hold => hold.present),
    positiveControl,
    holds,
  }
}

function runtimeRequire(): NodeJS.Require {
  return createRequire(resolve("reference-implementation/package.json"))
}

export function resolveBinaryPath(): string {
  const require = runtimeRequire()
  const manifestPath = join(
    dirname(require.resolve("patchright-core/package.json")),
    "browsers.json"
  )
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    browsers: { name: string; revision: string }[]
  }
  const revision = manifest.browsers.find(
    browser => browser.name === "chromium"
  )?.revision
  if (!revision || !/^\d+$/u.test(revision))
    throw new Error("missing Chromium revision in Patchright manifest")
  const directory =
    process.arch === "x64"
      ? "chrome-linux64"
      : process.arch === "arm64"
        ? "chrome-linux-arm64"
        : undefined
  if (process.platform !== "linux" || !directory)
    throw new Error("unsupported image platform")
  return join(
    process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/patchright-browsers",
    `chromium-${revision}`,
    directory,
    "chrome"
  )
}

export function binaryCommand(binaryPath: string): boolean {
  const inventory = JSON.parse(
    readFileSync(new URL("./browser-trust-holds.json", import.meta.url), "utf8")
  ) as Inventory
  const binary = readFileSync(binaryPath)
  const result = inspectBinary(binary, inventory)
  console.log(
    JSON.stringify({
      kind: "DER-containment-only",
      binaryPath,
      sha256: sha256(binary),
      ...result,
    })
  )
  if (!result.positiveControl.present) {
    console.error(
      "[browser-trust-oracle] FAIL positive control absent; containment method unsound for this binary"
    )
    return false
  }
  for (const hold of result.holds) {
    console.log(
      hold.present
        ? `[browser-trust-oracle] HOLD ${hold.name}: ${hold.reentry}`
        : `[browser-trust-oracle] hold resolved: remove it and record the qualifying versions: ${hold.name}`
    )
  }
  console.log(
    "[browser-trust-oracle] Inventory consistency only; HOLD is not a security pass or proof of trust."
  )
  return result.ok
}

export function probeURLs(
  raw = process.env.PDPP_BROWSER_TRUST_REJECT_URLS
): string[] {
  const urls =
    raw === undefined
      ? [
          "https://dv-g3b-emudhra.we-have-a-problem.com",
          "https://dv-g3b-aaa-emudhra.we-have-a-problem.com",
        ]
      : raw.split(/[\s,]+/u).filter(Boolean)
  if (!urls.length) throw new Error("reject URL list must not be empty")
  for (const url of urls)
    if (new URL(url).protocol !== "https:")
      throw new Error("trust probe requires HTTPS URLs")
  return urls
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function firstNavigation(
  mode: string,
  binaryPath: string
): Promise<boolean> {
  if (process.env.PDPP_BROWSER_TRUST_PROBE !== "1")
    throw new Error("first-navigation requires PDPP_BROWSER_TRUST_PROBE=1")
  if (mode !== "compiled" && mode !== "as-launched")
    throw new Error("--mode must be compiled or as-launched")
  // A channel override would test another browser while hashing the bundled one.
  if (process.env.PDPP_BROWSER_CHANNEL?.trim())
    throw new Error(
      "unset PDPP_BROWSER_CHANNEL: probe must use bundled Chromium"
    )
  const extraArgs = process.env.PDPP_BROWSER_EXTRA_ARGS
  if (
    /ignore-certificate-errors|allow-insecure-localhost|ignore-urlfetcher-cert-requests/iu.test(
      extraArgs ?? ""
    )
  ) {
    throw new Error("certificate-error bypass arguments are forbidden")
  }
  const urls = probeURLs()
  const controlURL =
    process.env.PDPP_BROWSER_TRUST_CONTROL_URL || "https://example.com"
  probeURLs(controlURL)
  const binarySha256 = sha256(readFileSync(binaryPath))
  // Bound to the existing production launcher, not copied flags. Its signature
  // was supplied by the owner; an actual exact-image run must verify this binding.
  const { acquireIsolatedBrowser } =
    await import("../packages/polyfill-connectors/src/browser-launch.ts")
  const results: Record<string, unknown>[] = []
  let ok = true
  for (const url of urls) {
    // Every reject URL is the FIRST navigation in its own fresh profile.
    const root = mkdtempSync(join(tmpdir(), "pdpp-browser-trust-"))
    const profileName = "trust-oracle"
    const profileDir = join(root, profileName)
    const originalRoot = process.env.PDPP_BROWSER_PROFILE_ROOT
    const record: Record<string, unknown> = {
      url,
      controlURL,
      certificateRevocationBeforeLaunch: existsSync(
        join(profileDir, "CertificateRevocation")
      ),
    }
    let acquired: Awaited<ReturnType<typeof acquireIsolatedBrowser>> | undefined
    try {
      process.env.PDPP_BROWSER_PROFILE_ROOT = root
      if (mode === "compiled")
        process.env.PDPP_BROWSER_EXTRA_ARGS = [
          extraArgs,
          "--disable-component-update",
        ]
          .filter(Boolean)
          .join(" ")
      acquired = await acquireIsolatedBrowser({ profileName })
      record.certificateRevocationBeforeNavigation = existsSync(
        join(profileDir, "CertificateRevocation")
      )
      const page =
        acquired.context.pages()[0] ?? (await acquired.context.newPage())
      let rejected = false
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        })
        record.reject = {
          outcome: "loaded",
          status: response?.status() ?? null,
          finalURL: page.url(),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const certificateError = /net::ERR_CERT_[A-Z0-9_]+/u.exec(message)?.[0]
        rejected = Boolean(certificateError)
        record.reject = {
          outcome: certificateError ? "certificate-error" : "other-error",
          certificateError: certificateError ?? null,
          message,
        }
      }
      let controlLoaded = false
      try {
        const response = await page.goto(controlURL, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        })
        controlLoaded = Boolean(response?.ok())
        record.control = {
          outcome: controlLoaded ? "loaded" : "http-error",
          status: response?.status() ?? null,
          finalURL: page.url(),
        }
      } catch (error) {
        record.control = {
          outcome: "error",
          message: error instanceof Error ? error.message : String(error),
        }
      }
      // Version inspection is AFTER first navigation, never a warm-up request.
      const session = await acquired.context.newCDPSession(page)
      try {
        record.browserVersion = await session.send("Browser.getVersion")
      } finally {
        await session.detach()
      }
      record.ok = rejected && controlLoaded
      ok = ok && rejected && controlLoaded
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      record.ok = false
      ok = false
    } finally {
      try {
        await acquired?.release()
      } catch (error) {
        record.cleanupError = String(error)
        record.ok = false
        ok = false
      }
      restoreEnvironment("PDPP_BROWSER_PROFILE_ROOT", originalRoot)
      restoreEnvironment("PDPP_BROWSER_EXTRA_ARGS", extraArgs)
      rmSync(root, { recursive: true, force: true })
    }
    results.push(record)
  }
  console.log(
    JSON.stringify({
      kind: "first-navigation",
      mode,
      binaryPath,
      binarySha256,
      ok,
      results,
      limitation:
        "Certificate errors alone do not attribute rejection to a root-store change. Compiled mode disables component updates but does not remove policies, runtime distrust, or other verification mechanisms.",
    })
  )
  return ok
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === "binary") {
    if (args.length > 1 || args[0]?.startsWith("--"))
      throw new Error("usage: binary [Chrome-binary-path]")
    process.exitCode = binaryCommand(args[0] ?? resolveBinaryPath()) ? 0 : 1
  } else if (command === "first-navigation") {
    if (args.length !== 2 || args[0] !== "--mode")
      throw new Error("usage: first-navigation --mode compiled|as-launched")
    if (process.env.PDPP_BROWSER_TRUST_PROBE !== "1")
      throw new Error("first-navigation requires PDPP_BROWSER_TRUST_PROBE=1")
    process.exitCode = (await firstNavigation(args[1], resolveBinaryPath()))
      ? 0
      : 1
  } else {
    throw new Error(
      "usage: browser-trust-oracle.ts binary [path] | first-navigation --mode compiled|as-launched"
    )
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
