import { execFileSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const releaseWorkflowPath = resolve(
  process.cwd(),
  ".github/workflows/release.yml"
)

function readReleaseWorkflow() {
  return readFileSync(releaseWorkflowPath, "utf8")
}

function readWorkflowStep(workflow: string, name: string) {
  const marker = `      - name: ${name}\n`
  const start = workflow.indexOf(marker)
  if (start === -1) throw new Error(`Missing workflow step: ${name}`)
  const next = workflow.indexOf("\n      - name: ", start + marker.length)
  return workflow.slice(start, next === -1 ? workflow.length : next)
}

function readWorkflowRunScript(workflow: string, name: string) {
  const step = readWorkflowStep(workflow, name)
  const marker = "        run: |\n"
  const start = step.indexOf(marker)
  if (start === -1)
    throw new Error(`Missing run script for workflow step: ${name}`)
  return step
    .slice(start + marker.length)
    .split("\n")
    .map(line => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n")
}

describe("release workflow", () => {
  it("builds manual-install artifacts on demand without an updater", () => {
    const workflow = readReleaseWorkflow()

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("pull_request:")
    expect(workflow).toContain("Stage verified release artifacts")
    expect(workflow).toContain("Publish complete platform set")
    expect(workflow).toContain("ubuntu-22.04")
    expect(workflow).toContain("windows-latest")
    expect(workflow).toContain("macos-15")
    expect(workflow).toContain("macos-15-intel")
    expect(workflow).toContain(
      "verify-bundled-personal-server.mjs --platform linux"
    )
    expect(workflow).toContain(
      "verify-bundled-personal-server.mjs --platform windows"
    )
    expect(workflow).toContain(
      "verification_args=(--platform macos --expected-arch"
    )
    expect(workflow).toContain("npm ci")
    expect(workflow).toContain('node-version: "22.23.1"')
    expect(workflow).toContain("Stage Node.js runtime sidecar")
    expect(workflow).toContain(
      'node scripts/stage-pdpp-node.mjs --target "${{ matrix.target }}"'
    )
    expect(workflow).toContain(
      "npm run build -- --require-browser --target ${{ matrix.pkg_target }}"
    )
    expect(workflow).toContain("Install PDPP runtime dependencies")
    expect(workflow).toContain("node scripts/ensure-pdpp-runtime.js")
    expect(workflow).toContain("if: github.event_name == 'release'")
    expect(workflow).not.toMatch(
      /updater|latest\.json|TAURI_SIGNING_PRIVATE_KEY/i
    )
  })

  it("keeps signing optional and has no Vana or Corsali release dependency", () => {
    const workflow = readReleaseWorkflow()
    const signedBuild = readWorkflowStep(workflow, "Build signed Tauri app")
    const unsignedBuild = readWorkflowStep(workflow, "Build unsigned Tauri app")
    const finalizeBundles = readWorkflowStep(
      workflow,
      "Finalize platform bundles"
    )
    const removeGeneratedDmgs = `find "$bundle_root/dmg" -maxdepth 1 -type f -name '*.dmg' -delete`

    expect(workflow).toContain("APPLE_SIGNING_IDENTITY")
    expect(signedBuild).toContain("env.APPLE_SIGNING_AVAILABLE == 'true'")
    expect(signedBuild).toContain(
      "APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}"
    )
    expect(unsignedBuild).toContain("env.APPLE_SIGNING_AVAILABLE != 'true'")
    expect(unsignedBuild).not.toContain("APPLE_SIGNING_IDENTITY")
    expect(workflow).toContain(
      "github.event_name == 'release' && secrets.APPLE_BUILD_CERTIFICATE_BASE64 != ''"
    )
    expect(workflow).toContain(
      "env.APPLE_SIGNING_AVAILABLE == 'true' && secrets.APPLE_SIGNING_IDENTITY || ''"
    )
    expect(workflow).toContain("verification_args+=(--verify-code-signature)")
    expect(workflow).toContain(
      'codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" src-tauri/binaries/pdpp-node-${{ matrix.target }}'
    )
    expect(workflow).toContain("codesign --force --deep --options runtime")
    expect(workflow).toContain(
      "node scripts/create-macos-dmg.mjs --volume-name DataConnect"
    )
    expect(finalizeBundles).toContain(removeGeneratedDmgs)
    expect(finalizeBundles.indexOf(removeGeneratedDmgs)).toBeLessThan(
      finalizeBundles.indexOf("node scripts/create-macos-dmg.mjs")
    )
    expect(workflow).toContain("verify-release-ref.mjs --release-tag")
    expect(workflow).not.toContain("VITE_PRIVY_APP_ID")
    expect(workflow).not.toContain("VITE_PRIVY_CLIENT_ID")
    expect(workflow).not.toMatch(/msi\/\*\.msi/i)
    expect(workflow).not.toMatch(/vana\.(?:com|org)|corsali/i)
  })

  it("replaces Tauri's x64 DMG without deleting artifacts outside the bundle", () => {
    const workflow = readReleaseWorkflow()
    const cleanupCommand = workflow.match(
      /^\s+(find "\$bundle_root\/dmg" -maxdepth 1 -type f -name '\*\.dmg' -delete)$/m
    )?.[1]
    expect(cleanupCommand).toBeTruthy()

    const root = mkdtempSync(join(tmpdir(), "data-connect-dmg-cleanup-"))
    const bundleRoot = join(root, "target", "bundle")
    const dmgDirectory = join(bundleRoot, "dmg")
    const staleTauriDmg = join(dmgDirectory, "DataConnect_0.7.53_x64.dmg")
    const canonicalDmg = join(dmgDirectory, "DataConnect_0.7.53_x86_64.dmg")
    const outsideDmg = join(root, "keep-me.dmg")

    try {
      mkdirSync(dmgDirectory, { recursive: true })
      writeFileSync(staleTauriDmg, "tauri output")
      writeFileSync(outsideDmg, "outside target")

      execFileSync("bash", ["-c", cleanupCommand!], {
        env: { ...process.env, bundle_root: bundleRoot },
      })
      writeFileSync(canonicalDmg, "canonical output")

      expect(readdirSync(dmgDirectory)).toEqual([basename(canonicalDmg)])
      expect(readFileSync(outsideDmg, "utf8")).toBe("outside target")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps untrusted builds read-only and publishes only a complete release matrix", () => {
    const workflow = readReleaseWorkflow()
    const stagedArtifacts = readWorkflowStep(
      workflow,
      "Stage verified release artifacts"
    )
    const downloadArtifacts = readWorkflowStep(
      workflow,
      "Download verified release artifacts"
    )
    const publishArtifacts = readWorkflowStep(
      workflow,
      "Publish complete platform set"
    )

    expect(workflow).toContain("permissions:\n  contents: read")
    expect(workflow).toContain(
      "publish:\n    if: github.event_name == 'release'\n    needs: build"
    )
    expect(workflow).toContain("permissions:\n      contents: write")
    expect(stagedArtifacts).toContain("if: github.event_name == 'release'")
    expect(stagedArtifacts).toContain(
      "manual-install-${{ matrix.artifact_key }}"
    )
    expect(downloadArtifacts).toContain("pattern: manual-install-*")
    expect(publishArtifacts).toContain("manual-install-macos-arm64 'dmg/*.dmg'")
    expect(publishArtifacts).toContain("manual-install-macos-x64 'dmg/*.dmg'")
    expect(publishArtifacts).toContain("manual-install-linux-x64 'deb/*.deb'")
    expect(publishArtifacts).toContain(
      "manual-install-linux-x64 'appimage/*.AppImage'"
    )
    expect(publishArtifacts).toContain(
      "manual-install-windows-x64 'nsis/*.exe'"
    )
    expect(publishArtifacts).toContain('${#artifacts[@]}" -ne 5')
    expect(publishArtifacts).toContain(
      'gh release upload "$RELEASE_TAG" "${artifacts[@]}" --clobber'
    )
  })

  it("publishes five files from upload-artifact's preserved subdirectories", () => {
    const publishScript = readWorkflowRunScript(
      readReleaseWorkflow(),
      "Publish complete platform set"
    )
    const root = mkdtempSync(join(tmpdir(), "data-connect-publish-layout-"))
    const expectedAssets = [
      "manual-install-macos-arm64/dmg/DataConnect_0.7.54_arm64.dmg",
      "manual-install-macos-x64/dmg/DataConnect_0.7.54_x86_64.dmg",
      "manual-install-linux-x64/deb/DataConnect_0.7.54_amd64.deb",
      "manual-install-linux-x64/appimage/DataConnect_0.7.54_amd64.AppImage",
      "manual-install-windows-x64/nsis/DataConnect_0.7.54_x64-setup.exe",
    ]

    try {
      for (const asset of expectedAssets) {
        const path = join(root, "release-artifacts", asset)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, "verified artifact")
      }

      const output = execFileSync(
        "bash",
        ["-c", `gh() { printf 'GH_ARG=%s\\n' "$@"; }\n${publishScript}`],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, RELEASE_TAG: "v0.7.54" },
        }
      )
      const uploadArgs = output
        .split("\n")
        .filter(line => line.startsWith("GH_ARG="))
        .map(line => line.slice("GH_ARG=".length))

      expect(uploadArgs.slice(0, 3)).toEqual(["release", "upload", "v0.7.54"])
      expect(uploadArgs.slice(3, -1).sort()).toEqual(
        expectedAssets.map(asset => `release-artifacts/${asset}`).sort()
      )
      expect(uploadArgs.at(-1)).toBe("--clobber")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
