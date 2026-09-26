// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawnSync } from "node:child_process"
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
  const nextJob = workflow
    .slice(start + marker.length)
    .search(/\n  [a-z][\w-]+:\n/)
  const end =
    next === -1
      ? nextJob === -1
        ? workflow.length
        : start + marker.length + nextJob
      : nextJob === -1
        ? next
        : Math.min(next, start + marker.length + nextJob)
  return workflow.slice(start, end)
}

// Returns why the publish-core-image job could push an image it has not
// scanned, or [] when every GHCR write follows the full-layer secret scan.
function coreImageScanGaps(workflow: string) {
  const job = workflow.slice(
    workflow.indexOf("  publish-core-image:"),
    workflow.indexOf("  promote-core-latest:")
  )
  const gaps: string[] = []
  const step = (name: string) => {
    const marker = `      - name: ${name}\n`
    return job.includes(marker) ? readWorkflowStep(job, name) : undefined
  }
  const build = step("Build Core image without pushing")
  const scan = step("Scan every layer of the built Core image for secret files")
  const push = step("Push the scanned Core image")
  const rescan = step("Re-scan the pushed Core image from GHCR by digest")
  if (!build?.includes("push: false")) gaps.push("build step pushes")
  if (
    !build?.includes("outputs: type=oci,dest=${{ runner.temp }}/core.oci.tar")
  )
    gaps.push("build step does not write the OCI archive")
  if (
    !scan?.includes(
      'check-image-secrets.sh oci-archive "$RUNNER_TEMP/core.oci.tar"'
    )
  )
    gaps.push("no scan of the built archive")
  if (!push?.includes("--preserve-digests oci-archive:/work/core.oci.tar"))
    gaps.push("push does not copy the scanned archive")
  if (!push?.includes('"$pushed" != "$SCANNED_DIGEST"'))
    gaps.push("push does not assert pushed digest equals scanned digest")
  if (!push?.includes("SCANNED_DIGEST: ${{ steps.scan-core.outputs.digest }}"))
    gaps.push("push does not take the digest from the scan")
  if (!rescan?.includes('"docker://$PDPP_IMAGE@$PUSHED_DIGEST"'))
    gaps.push("no re-scan of the pushed digest")
  const order = [build, scan, push, rescan].map(text =>
    text === undefined ? -1 : job.indexOf(text)
  )
  if (order.some((at, n) => at === -1 || (n > 0 && at < order[n - 1])))
    gaps.push("steps are not ordered build, scan, push, re-scan")
  // Any other GHCR write in the job must come after the scan.
  const scanAt = scan === undefined ? job.length : job.indexOf(scan)
  for (const write of [
    "push: true",
    "skopeo copy",
    "docker push",
    "imagetools create",
  ]) {
    const at = job.indexOf(write)
    if (at !== -1 && at < scanAt) gaps.push(`"${write}" before the scan`)
  }
  return gaps
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

function readCleanInstallBashScripts(workflow: string) {
  const cleanInstall = workflow.slice(workflow.indexOf("\n  clean-install:\n"))
  const steps = cleanInstall.split(/\n      - name: /).slice(1)

  return steps.flatMap(step => {
    if (!/^        shell: bash$/m.test(step)) return []
    const marker = "        run: |\n"
    const start = step.indexOf(marker)
    const inline = step.match(/^        run: (.+)$/m)?.[1]
    if (start === -1 && inline === undefined) return []
    const script =
      (start === -1 ? inline : undefined) ??
      step
        .slice(start + marker.length)
        .split("\n")
        .map(line => (line.startsWith("          ") ? line.slice(10) : line))
        .join("\n")
    return [{ name: step.split("\n", 1)[0], script }]
  })
}

// Values GitHub Actions would substitute into a run script before the runner's
// shell ever sees it. Tests that execute a step's script have to do the same
// substitution, because `${{ ... }}` is not shell syntax -- bash rejects it as a
// bad substitution and the step dies before reaching the behaviour under test.
const ACTIONS_EXPRESSION_VALUES: Record<string, string> = {
  "github.repository": "PDP-Connect/data-connect",
}

const ACTIONS_EXPRESSION_PATTERN = /\$\{\{\s*(.+?)\s*\}\}/g

// Substitutes the expressions in ACTIONS_EXPRESSION_VALUES and throws on any
// other, so a workflow edit that introduces an unmapped expression fails here
// with the expression named rather than as an opaque shell error -- or, worse,
// silently runs a script that no longer matches the real step.
function substituteActionsExpressions(script: string) {
  return script.replace(ACTIONS_EXPRESSION_PATTERN, (match, expression) => {
    const value = ACTIONS_EXPRESSION_VALUES[expression]
    if (value === undefined) {
      throw new Error(
        `Unmapped Actions expression in workflow step script: ${match}. ` +
          `Add "${expression}" to ACTIONS_EXPRESSION_VALUES with the value the test should run against.`
      )
    }
    return value
  })
}

describe("release workflow", () => {
  it("keeps every clean-install Bash script portable across runner shells", () => {
    const scripts = readCleanInstallBashScripts(readReleaseWorkflow())

    expect(scripts.map(({ name }) => name)).toEqual([
      "Download release installer",
      "Install and launch (macOS)",
      "Assert owner password not yet set and sidecars serving",
      "Collect evidence",
    ])

    for (const { name, script } of scripts) {
      expect(script, name).not.toMatch(
        /\b(?:mapfile|readarray|coproc)\b|\bdeclare\s+-[A-Za-z]*[Ang][A-Za-z]*\b|\$\{[A-Za-z_][A-Za-z0-9_]*(?:,,?|\^\^?)[^}]*\}|\bshopt\s+-s\s+globstar|&>>|\|&|;{1,2}&/
      )
      // shasum is absent from Git Bash on windows-latest. The hash step uses
      // Node, which Setup Node provides on all three clean-install runners.
      expect(script, name).not.toMatch(/\bshasum\b/)
      const syntaxCheck = spawnSync("bash", ["-n"], { input: script })
      expect(syntaxCheck.status, `${name}: ${syntaxCheck.stderr}`).toBe(0)
    }

    // Verify the shell commands needed by each runner image stay in steps
    // whose runner provides them. Setup Node provides node everywhere; the
    // hosted images provide gh and Git Bash coreutils; macOS provides its
    // installer tools; windows-latest provides pwsh; macOS provides ps.
    const requiredCommands = [
      [0, ["gh", "mkdir", "node"]],
      [1, ["mktemp", "hdiutil", "tee", "ditto", "codesign", "open"]],
      [2, ["node"]],
      [3, ["mkdir", "cp", "ls", "pwsh", "ps"]],
    ] as const
    for (const [index, commands] of requiredCommands) {
      for (const command of commands) {
        expect(
          scripts[index].script,
          `${scripts[index].name}: ${command}`
        ).toMatch(new RegExp(`\\b${command}\\b`))
      }
    }
    expect(scripts[0].script).toContain("gh release download")
    expect(scripts[3].script).toContain("pwsh -NoProfile")
  })

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
    expect(workflow).toContain('node-version: "24.21.0"')
    expect(workflow).toContain("Stage Node.js runtime sidecar")
    expect(workflow).toContain(
      'node scripts/stage-pdpp-node.mjs --target "${{ matrix.target }}"'
    )
    expect(workflow).toContain(
      "npm run build -- --require-browser --target ${{ matrix.pkg_target }}"
    )
    expect(workflow).toContain("Install PDPP runtime dependencies")
    expect(workflow).toContain("node scripts/ensure-pdpp-runtime.js")
    expect(workflow).toContain("Stage reference-stack roots")
    expect(workflow).toContain(
      "node scripts/ensure-console-stack.js --profile release"
    )
    expect(workflow).toContain("node scripts/ensure-reference-stack.js \\")
    expect(workflow).toContain('--node-binary "$node_binary"')
    expect(workflow).toContain(
      "node scripts/verify-reference-stack.mjs --profile release"
    )
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

  it("publishes the Core image only from the release workflow", () => {
    const workflow = readReleaseWorkflow()
    const publishCoreImage = workflow.slice(
      workflow.indexOf("  publish-core-image:")
    )
    const coreMetadata = readWorkflowStep(workflow, "Extract Docker metadata")
    const buildCore = readWorkflowStep(
      workflow,
      "Build Core image without pushing"
    )

    expect(workflow).toContain(
      "publish-core-image:\n    if: github.event_name == 'release'\n    needs: [build, publish]"
    )
    expect(publishCoreImage).toContain("packages: write")
    expect(publishCoreImage).not.toContain("id-token:")
    expect(publishCoreImage).not.toContain("attestations:")
    expect(publishCoreImage).toContain("ghcr.io/${GITHUB_REPOSITORY,,}/core")
    expect(publishCoreImage).toContain(
      "node scripts/verify-release-ref.mjs --release-tag"
    )
    expect(coreMetadata).toContain("type=semver,pattern={{version}}")
    expect(coreMetadata).toContain("latest=false")
    expect(coreMetadata).not.toContain("value=latest")
    expect(coreMetadata).not.toContain("dispatch-sha-")
    expect(buildCore).toContain("push: false")
    expect(buildCore).toContain("target: core")
    expect(buildCore).toContain("platforms: linux/amd64,linux/arm64")
    expect(buildCore).toContain("PDPP_REFERENCE_REVISION=${{ github.sha }}")
  })

  it("runs clean-install instead of build only on a dispatch that names a release", () => {
    const workflow = readReleaseWorkflow()
    type Trigger = { event: string; releaseTag?: string }
    // Evaluates the simple ==, !=, &&, || job gates this workflow uses.
    const runs = (job: string, trigger: Trigger) => {
      const gate = new RegExp(`\\n  ${job}:\\n(?:    #.*\\n)*    if: (.*)\\n`)
      const match = workflow.match(gate)
      if (!match) return true
      const expression = match[1]
        .replaceAll("github.event_name", "event")
        .replaceAll("inputs.release_tag", "releaseTag")
        .replaceAll("!github.event.release.prerelease", "true")
        .replaceAll("!=", "!==")
        .replaceAll(/([^!=])==/g, "$1===")
      return new Function("event", "releaseTag", `return ${expression}`)(
        trigger.event,
        trigger.event === "workflow_dispatch" ? (trigger.releaseTag ?? "") : ""
      )
    }
    const scenarios: Array<[Trigger, string[]]> = [
      [{ event: "workflow_dispatch", releaseTag: "v2.4.0" }, ["clean-install"]],
      [{ event: "workflow_dispatch", releaseTag: "" }, ["build"]],
      [{ event: "pull_request" }, ["build"]],
      [
        { event: "release" },
        ["build", "publish", "publish-core-image", "promote-core-latest"],
      ],
    ]
    const jobs = [
      "build",
      "publish",
      "publish-core-image",
      "promote-core-latest",
      "clean-install",
    ]
    for (const [trigger, expected] of scenarios) {
      expect(
        jobs.filter(job => runs(job, trigger)),
        JSON.stringify(trigger)
      ).toEqual(expected)
    }

    expect(workflow).toContain(
      '      release_tag:\n        description: Existing release tag to clean-install on fresh VMs instead of building (leave empty to build)\n        required: false\n        default: ""'
    )
    const cleanInstall = workflow.slice(
      workflow.indexOf("\n  clean-install:\n")
    )
    expect(cleanInstall).toContain(
      "    permissions:\n      contents: read\n    strategy:"
    )
    for (const platform of ["macos-15", "macos-15-intel", "windows-latest"]) {
      expect(cleanInstall).toContain(`          - platform: ${platform}\n`)
    }
    expect(cleanInstall.match(/          - platform: /g)).toHaveLength(3)
    expect(cleanInstall).not.toMatch(/needs:|write|gh release upload|docker\//)
    expect(cleanInstall).toContain("if: always()")
    expect(readWorkflowStep(workflow, "Upload evidence")).toContain(
      "if: always()"
    )
    expect(workflow).not.toContain("clean-install-acceptance.yml")
  })

  it("scans every layer of the exact Core image before any GHCR write", () => {
    const workflow = readReleaseWorkflow()
    expect(coreImageScanGaps(workflow)).toEqual([])

    const scanStep = readWorkflowStep(
      workflow,
      "Scan every layer of the built Core image for secret files"
    )
    const withoutScan = workflow.replace(scanStep, "")
    expect(withoutScan).not.toBe(workflow)
    expect(coreImageScanGaps(withoutScan)).toContain(
      "no scan of the built archive"
    )

    const pushFirst = workflow.replace("push: false", "push: true")
    expect(coreImageScanGaps(pushFirst)).toEqual(
      expect.arrayContaining([
        "build step pushes",
        '"push: true" before the scan',
      ])
    )

    const rebuilds = workflow.replace(
      "--preserve-digests oci-archive:/work/core.oci.tar",
      "oci-archive:/work/core.oci.tar"
    )
    expect(coreImageScanGaps(rebuilds)).toContain(
      "push does not copy the scanned archive"
    )
  })

  it("pushes only versioned Core tags and serializes only latest promotion", () => {
    const workflow = readReleaseWorkflow()
    const publishCoreImage = workflow.slice(
      workflow.indexOf("  publish-core-image:"),
      workflow.indexOf("  promote-core-latest:")
    )
    const promoter = workflow.slice(workflow.indexOf("  promote-core-latest:"))

    expect(publishCoreImage).not.toContain("concurrency")
    expect(publishCoreImage).not.toMatch(/:latest|value=latest/)
    expect(publishCoreImage).toContain(
      "outputs:\n      digest: ${{ steps.push-core.outputs.digest }}\n      version: ${{ steps.meta.outputs.version }}"
    )
    expect(readWorkflowStep(workflow, "Push the scanned Core image")).toContain(
      "id: push-core"
    )
    expect(workflow.match(/concurrency:/g)).toHaveLength(1)
    expect(promoter).toContain(
      "promote-core-latest:\n    if: github.event_name == 'release' && !github.event.release.prerelease\n    needs: publish-core-image"
    )
    expect(promoter).toContain(
      "concurrency:\n      group: core-image-latest-promotion\n      cancel-in-progress: false"
    )
    expect(promoter).toContain(
      "permissions:\n      contents: read\n      packages: write\n    steps:"
    )
    expect(promoter).toContain(
      "CANDIDATE_DIGEST: ${{ needs.publish-core-image.outputs.digest }}"
    )
  })

  describe("latest promotion script", () => {
    const repository = ACTIONS_EXPRESSION_VALUES["github.repository"]
    const image = `ghcr.io/${repository.toLowerCase()}/core`
    const digest = `sha256:${"b".repeat(64)}`
    const create = `CREATE=buildx imagetools create --tag ${image}:latest ${image}@${digest}`
    const stubs = `
docker() {
  if [ "$3" = create ]; then printf 'CREATE=%s\\n' "$*"; return; fi
  [ "$4" = "${image}:latest" ] || { echo "unexpected docker $*" >&2; return 1; }
  case "$FX_LATEST" in
    MISSING) echo "ERROR: ${image}:latest: not found" >&2; return 1 ;;
    DENIED) echo "ERROR: unexpected status 403 Forbidden" >&2; return 1 ;;
    *) printf '{"linux/amd64":{"config":{"Labels":{"org.opencontainers.image.version":"%s"}}},"linux/arm64":{"config":{"Labels":{"org.opencontainers.image.version":"%s"}}}}\\n' "$FX_LATEST" "\${FX_LATEST_ARM64:-$FX_LATEST}" ;;
  esac
}
`

    function runPromote(candidate: string, latest: string, extra = {}) {
      const script = readWorkflowRunScript(
        readReleaseWorkflow(),
        "Promote Core image to latest if newer"
      )
      const root = mkdtempSync(join(tmpdir(), "data-connect-promote-"))
      try {
        const result = spawnSync("bash", ["-c", `${stubs}\n${script}`], {
          encoding: "utf8",
          env: {
            ...process.env,
            REPOSITORY: repository,
            RUNNER_TEMP: root,
            CANDIDATE_DIGEST: digest,
            CANDIDATE_VERSION: candidate,
            FX_LATEST: latest,
            ...extra,
          },
        })
        return {
          status: result.status,
          creates: result.stdout
            .split("\n")
            .filter(line => line.startsWith("CREATE=")),
        }
      } finally {
        rmSync(root, { force: true, recursive: true })
      }
    }

    it.each([
      ["1.5.1", "1.5.0"],
      ["1.6.0", "1.5.9"],
      ["2.0.0", "1.99.99"],
      ["1.10.0", "1.9.0"],
      ["1.5.1", "MISSING"],
    ])("promotes %s over latest %s", (candidate, latest) => {
      expect(runPromote(candidate, latest)).toEqual({
        status: 0,
        creates: [create],
      })
    })

    it.each([
      ["1.5.1", "1.5.1"],
      ["1.5.0", "1.5.1"],
      ["1.9.0", "1.10.0"],
      ["1.99.99", "2.0.0"],
      ["1.6.0-rc.1", "1.5.0"],
    ])("leaves latest alone for %s when latest is %s", (candidate, latest) => {
      expect(runPromote(candidate, latest)).toEqual({ status: 0, creates: [] })
    })

    it.each([
      ["an unreadable latest", "1.5.1", "DENIED", {}],
      ["an unlabelled latest", "1.5.1", "", {}],
      ["a prerelease latest", "1.5.1", "1.5.0-rc.1", {}],
      [
        "mixed platform versions",
        "1.5.1",
        "1.5.0",
        { FX_LATEST_ARM64: "1.4.0" },
      ],
      [
        "a malformed digest",
        "1.5.1",
        "1.5.0",
        { CANDIDATE_DIGEST: "sha256:x" },
      ],
    ])("fails closed on %s", (_name, candidate, latest, extra) => {
      const run = runPromote(candidate, latest, extra)
      expect(run.status).not.toBe(0)
      expect(run.creates).toEqual([])
    })
  })

  it("publishes five files from upload-artifact's preserved subdirectories", () => {
    const publishScript = substituteActionsExpressions(
      readWorkflowRunScript(
        readReleaseWorkflow(),
        "Publish complete platform set"
      )
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
      expect(uploadArgs.slice(-3)).toEqual([
        "--clobber",
        "--repo",
        ACTIONS_EXPRESSION_VALUES["github.repository"],
      ])
      expect(uploadArgs.slice(3, -3).sort()).toEqual(
        expectedAssets.map(asset => `release-artifacts/${asset}`).sort()
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
