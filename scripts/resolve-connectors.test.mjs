// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  artifactCertificateIdentityResolver,
  checkInstalledLock,
  installConnectorsAtomically,
  ociCertificateIdentityResolver,
  LOCKED_ARTIFACT_SOURCE,
  resolveIndexUrl,
  resolveOciProfiles,
  recoverInterruptedInstall,
} from "./resolve-connectors.js"

const lock = JSON.parse(readFileSync("connectors/lock.json", "utf8"))
const legacyArtifacts = lock.connectors.filter(connector =>
  connector.artifactUrl?.startsWith("https://github.com/vana-com/")
)

describe("connector artifact signer identities", () => {
  it("trusts only the six exact legacy artifact URLs retained by the lock", () => {
    expect(legacyArtifacts).toHaveLength(6)
    for (const connector of legacyArtifacts) {
      expect(
        artifactCertificateIdentityResolver({
          artifactUrl: connector.artifactUrl,
        })
      ).toContain("github.com/vana-com/data-connectors/.github/workflows/")
    }
  })

  it("rejects lookalike and hostile repository URLs", () => {
    const lockedUrl = legacyArtifacts[0].artifactUrl
    const hostileUrls = [
      lockedUrl.replace("github.com/vana-com/", "github.com/attacker/"),
      `${lockedUrl}.extra`,
      lockedUrl.replace("github.com/", "github.com.attacker.invalid/"),
      lockedUrl.replace("connectors-3f944c668395", "connectors-hostile"),
      "https://github.com/attacker/data-connectors/releases/download/connectors-48440fead534/github-pdpp-0.5.0.tgz",
      "https://github.com/PDP-Connect-attacker/data-connectors/releases/download/connectors-48440fead534/github-pdpp-0.5.0.tgz",
    ]

    for (const artifactUrl of hostileUrls) {
      expect(artifactCertificateIdentityResolver({ artifactUrl })).toBeNull()
    }
  })
})

describe("connector index selection", () => {
  it("pins this release to immutable index, artifact, and signature URLs", () => {
    const releasePath = "/releases/download/connectors-48440fead534/"
    expect(lock.index.url).toContain(releasePath)
    expect(lock.index.url).not.toContain("connectors-latest")

    for (const connector of lock.connectors) {
      if (connector.oci) {
        expect(connector.oci.registry).toBe("ghcr.io")
        expect(connector.oci.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(connector.artifactUrl).toBeUndefined()
        continue
      }
      if (connector.artifactUrl?.startsWith("https://github.com/vana-com/")) {
        continue
      }
      expect(connector.artifactUrl).toContain(releasePath)
      expect(connector.artifactSignature.bundleUrl).toContain(releasePath)
    }
  })

  it("checks an existing remote lock against its pinned index", () => {
    expect(
      resolveIndexUrl({
        checkMode: true,
        explicitIndexUrl: null,
        existingLock: lock,
      })
    ).toBe(lock.index.url)
  })

  it("honors an explicit index and uses latest only for an update", () => {
    const explicitIndexUrl = "https://example.com/connector-index.json"
    expect(
      resolveIndexUrl({
        checkMode: true,
        explicitIndexUrl,
        existingLock: lock,
      })
    ).toBe(explicitIndexUrl)
    expect(
      resolveIndexUrl({
        checkMode: false,
        explicitIndexUrl: null,
        existingLock: lock,
      })
    ).toBeNull()
  })

  it("installs a lock without a remote index that could rewrite its URLs", () => {
    expect(LOCKED_ARTIFACT_SOURCE).toEqual({ mode: "locked", doc: {} })
    expect(LOCKED_ARTIFACT_SOURCE.mode).not.toBe("remote")
  })
})

const identity =
  "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main"
const anchoredIdentityPattern = value =>
  `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
const digest = bytes =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const json = value => Buffer.from(`${JSON.stringify(value)}\n`)
function put(root, path, bytes) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), bytes)
}
function archive(root, name, files) {
  const input = join(root, `${name}-input`)
  for (const [path, bytes] of Object.entries(files)) put(input, path, bytes)
  const output = join(root, `${name}.tgz`)
  execFileSync("tar", ["-czf", output, "-C", input, "."])
  return readFileSync(output)
}
function tree(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const path = join(entry.parentPath, entry.name).slice(root.length + 1)
      return [path, readFileSync(join(root, path)).toString("base64")]
    })
    .sort(([a], [b]) => a.localeCompare(b))
}
async function temporary(run) {
  const root = mkdtempSync(join(tmpdir(), "dc-oci-test-"))
  try {
    return await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Reproduce PR A's OCI wire fixture. The core still parses manifests, checks
// digests, extracts archives and assembles the cosign bundle. Only registry I/O
// and Fulcio/Rekor are replaced; the test verifier checks a real EC signature.
function fixture(root) {
  const key = "ynab",
    connectorId = `${key}-pdpp`,
    version = "0.3.0"
  const profile = json({
    connector_key: key,
    connector_id: `https://github.com/PDP-Connect/data-connectors/connector/${key}`,
    version,
    protocol_version: "1.0",
    display_name: "YNAB",
  })
  const code = Buffer.from("export const collect = () => {};\n")
  const provenance = json({ connector_key: key, version })
  const files = {
    "profile/collection-profile.json": profile,
    "dist/collection-profile.mjs": code,
    "provenance.json": provenance,
  }
  const tar = archive(root, "release", files)
  const entry = {
    connectorId,
    connectorKey: key,
    company: "YNAB",
    version,
    resolvedFrom: version,
    artifactKind: "pdpp-collection-profile",
    manifestPath: "profile/collection-profile.json",
    entrypointPath: "dist/collection-profile.mjs",
    provenancePath: "provenance.json",
    manifestSha256: digest(profile),
    entrypointSha256: digest(code),
    provenanceSha256: digest(provenance),
  }
  const objects = new Map()
  const layer = (bytes, mediaType) => {
    const hash = digest(bytes)
    objects.set(`blobs/${hash}`, bytes)
    return { mediaType, digest: hash, size: bytes.length }
  }
  const config = json({
    ...JSON.parse(profile),
    config_version: "1.0",
    profile_digest: digest(profile),
    entrypoint: "code/collection-profile.mjs",
  })
  const manifest = json({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: layer(config, "application/vnd.pdpp.connector.config.v1+json"),
    layers: [
      layer(profile, "application/vnd.pdpp.connector.profile.v1+json"),
      layer(
        archive(root, "code", { "code/collection-profile.mjs": code }),
        "application/vnd.pdpp.connector.code.v1.tar+gzip"
      ),
      layer(
        archive(root, "licenses", { LICENSE: "Apache-2.0\n" }),
        "application/vnd.pdpp.connector.licenses.v1.tar+gzip"
      ),
      layer(provenance, "application/vnd.pdpp.connector.provenance.v1+json"),
    ],
  })
  const manifestDigest = digest(manifest)
  objects.set(`manifests/${manifestDigest}`, manifest)
  objects.set(`manifests/${version}`, manifest)
  const payload = json({
    critical: { image: { "docker-manifest-digest": manifestDigest } },
  })
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  })
  const signature = sign("sha256", payload, privateKey).toString("base64")
  const rekorBundle = JSON.stringify({
    SignedEntryTimestamp: "test-set",
    Payload: {
      body: Buffer.from(
        JSON.stringify({ kind: "hashedrekord", apiVersion: "0.0.1" })
      ).toString("base64"),
      integratedTime: 1,
      logIndex: 1,
      logID: "0".repeat(64),
    },
  })
  objects.set(
    `manifests/${manifestDigest.replace(":", "-")}.sig`,
    json({
      schemaVersion: 2,
      layers: [
        {
          ...layer(payload, "application/vnd.dev.cosign.simplesigning.v1+json"),
          annotations: {
            "dev.cosignproject.cosign/signature": signature,
            "dev.sigstore.cosign/certificate": `-----BEGIN CERTIFICATE-----\n${Buffer.from(identity).toString("base64")}\n-----END CERTIFICATE-----`,
            "dev.sigstore.cosign/bundle": rekorBundle,
          },
        },
      ],
    })
  )
  const oci = {
    ...entry,
    oci: {
      registry: "ghcr.io",
      repository: `pdp-connect/connector/${key}`,
      digest: manifestDigest,
      configDigest: digest(config),
    },
  }
  const tarball = {
    ...entry,
    artifactPath: "release.tgz",
    artifactSha256: digest(tar),
  }
  const lockFor = (connector, lockVersion = "2.0") => ({
    lockVersion,
    dependencies: { [connectorId]: version },
    connectors: [connector],
  })
  const options = {
    fetchImpl: async url => {
      const path = new URL(url).pathname.replace(
        `/v2/${oci.oci.repository}/`,
        ""
      )
      const bytes = objects.get(decodeURIComponent(path))
      if (!bytes) throw new Error(`Unexpected registry request: ${url}`)
      return new Response(bytes, {
        status: 200,
        headers: { "docker-content-digest": digest(bytes) },
      })
    },
    sigstoreVerifier: async (bundle, bytes, policy) => {
      expect(policy.certificateIdentityURI).toBe(
        anchoredIdentityPattern(identity)
      )
      expect(policy.certificateIssuer).toBe(
        "https://token.actions.githubusercontent.com"
      )
      expect(
        Buffer.from(
          bundle.verificationMaterial.certificate.rawBytes,
          "base64"
        ).toString()
      ).toBe(identity)
      expect(
        verify(
          "sha256",
          bytes,
          publicKey,
          Buffer.from(bundle.messageSignature.signature, "base64")
        )
      ).toBe(true)
    },
  }
  return { files, oci, tarball, lockFor, options }
}

describe("OCI consumer acceptance", () => {
  it("B-T1 a v2 OCI lock installs byte-identical existing files to a v1 tarball lock", async () =>
    temporary(async root => {
      const f = fixture(root)
      mkdirSync(join(root, "v1"))
      mkdirSync(join(root, "v2"))
      await installConnectorsAtomically({
        lock: f.lockFor(f.tarball, "1.0"),
        source: { mode: "local", rootDir: root },
        installRoot: join(root, "v1"),
      })
      const migrated = await resolveOciProfiles(
        f.lockFor(f.tarball, "1.0"),
        f.options
      )
      expect(migrated.lockVersion).toBe("2.0")
      expect(migrated.connectors[0]).toEqual(f.oci)
      await installConnectorsAtomically({
        lock: migrated,
        installRoot: join(root, "v2"),
        ...f.options,
      })
      for (const path of Object.keys(f.files)) {
        expect(
          readFileSync(join(root, "v2/collection-profiles/ynab-pdpp", path))
        ).toEqual(
          readFileSync(join(root, "v1/collection-profiles/ynab-pdpp", path))
        )
      }
      expect(
        readFileSync(
          join(root, "v2/collection-profiles/ynab-pdpp/licenses/LICENSE"),
          "utf8"
        )
      ).toBe("Apache-2.0\n")
    }))

  it("migration retains legacy entries and refuses OCI bytes differing from the existing lock", async () =>
    temporary(async root => {
      const f = fixture(root),
        previous = f.lockFor(f.tarball, "1.0")
      previous.connectors.unshift(legacyArtifacts[0])
      const migrated = await resolveOciProfiles(previous, f.options)
      expect(migrated.connectors[0]).toEqual(legacyArtifacts[0])
      expect(previous.lockVersion).toBe("1.0")
      const drifted = {
        ...f.tarball,
        entrypointSha256: digest("different published bytes"),
      }
      await expect(
        resolveOciProfiles(f.lockFor(drifted, "1.0"), f.options)
      ).rejects.toThrow(
        "OCI bytes differ from locked ynab-pdpp: entrypointSha256"
      )
    }))

  it("B-T4 install root uses connectorId, never connectorKey", async () =>
    temporary(async root => {
      const f = fixture(root),
        installRoot = join(root, "installed")
      await installConnectorsAtomically({
        lock: f.lockFor(f.oci),
        installRoot,
        ...f.options,
      })
      expect(
        existsSync(
          join(
            installRoot,
            "collection-profiles/ynab-pdpp/profile/collection-profile.json"
          )
        )
      ).toBe(true)
      expect(existsSync(join(installRoot, "collection-profiles/ynab"))).toBe(
        false
      )
    }))

  it("B-T5 a failed install at connector 2 of 3 leaves the previous tree byte-identical", async () =>
    temporary(async root => {
      const installRoot = join(root, "installed")
      for (const id of ["first", "second", "third"])
        put(installRoot, `${id}/manifest.json`, `previous ${id}`)
      put(installRoot, "lock.json", "previous lock")
      const before = tree(installRoot),
        attempted = []
      await expect(
        installConnectorsAtomically({
          lock: {
            lockVersion: "2.0",
            connectors: ["first", "second", "third"].map(connectorId => ({
              connectorId,
            })),
          },
          installRoot,
          install: async ({ lock: next, installRoot: target }) => {
            for (const connector of next.connectors) {
              attempted.push(connector.connectorId)
              if (connector.connectorId === "second")
                throw new Error("injected second connector failure")
              put(
                target,
                `${connector.connectorId}/manifest.json`,
                "replacement bytes"
              )
            }
          },
        })
      ).rejects.toThrow("injected second connector failure")
      expect(attempted).toEqual(["first", "second"])
      expect(tree(installRoot)).toEqual(before)
      expect(readdirSync(root)).toEqual(["installed"])
    }))

  it("B-T6 --check succeeds with the network disabled and detects changed installed bytes", async () =>
    temporary(async root => {
      const f = fixture(root),
        installRoot = join(root, "connectors"),
        mixed = f.lockFor(f.oci)
      mkdirSync(installRoot)
      const legacy = {
        connectorId: "legacy",
        version: "1.0.0",
        sourceFiles: {
          metadata: "legacy/manifest.json",
          script: "legacy/script.js",
        },
        manifestSha256: digest("{}\n"),
        scriptSha256: digest("legacy\n"),
        artifactUrl: legacyArtifacts[0].artifactUrl,
      }
      mixed.connectors.push(legacy)
      mixed.dependencies.legacy = legacy.version
      await installConnectorsAtomically({
        lock: f.lockFor(f.oci),
        installRoot,
        ...f.options,
      })
      put(installRoot, legacy.sourceFiles.metadata, "{}\n")
      put(installRoot, legacy.sourceFiles.script, "legacy\n")
      put(installRoot, "lock.json", json(mixed))
      put(
        installRoot,
        "connector-dependencies.json",
        json({ connectors: mixed.dependencies })
      )
      for (const script of ["resolve-connectors.js", "is-main-module.js"])
        put(root, `scripts/${script}`, readFileSync(`scripts/${script}`))
      put(root, "package.json", '{"type":"module"}')
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir")
      put(
        root,
        "offline.mjs",
        'import http from "node:http"; import https from "node:https"; const deny = () => { throw new Error("NETWORK DISABLED") }; globalThis.fetch = deny; http.request = deny; http.get = deny; https.request = deny; https.get = deny;'
      )
      const env = {
        ...process.env,
        SKIP_CONNECTOR_FETCH: "",
        CONNECTORS_PATH: "",
        CONNECTOR_INDEX_URL: "",
      }
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          join(root, "offline.mjs"),
          join(root, "scripts/resolve-connectors.js"),
          "--check",
        ],
        { env, encoding: "utf8" }
      )
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
      expect(() =>
        checkInstalledLock({
          lock: mixed,
          installRoot,
          dependencies: { connectors: {} },
        })
      ).toThrow("lock drift")
      for (const invalid of [
        { ...f.oci, manifestPath: "../escape" },
        { ...f.oci, manifestSha256: "sha256:invalid" },
      ]) {
        expect(() =>
          checkInstalledLock({ lock: f.lockFor(invalid), installRoot })
        ).toThrow("Invalid installed file contract")
      }
      put(
        installRoot,
        "collection-profiles/ynab-pdpp/dist/collection-profile.mjs",
        "tampered\n"
      )
      expect(
        checkInstalledLock({
          lock: mixed,
          dependencies: { connectors: mixed.dependencies },
          installRoot,
        }).ok
      ).toBe(false)
      const entrypoint = join(
        installRoot,
        "collection-profiles/ynab-pdpp/dist/collection-profile.mjs"
      )
      rmSync(entrypoint)
      symlinkSync(
        join(root, "code-input/code/collection-profile.mjs"),
        entrypoint
      )
      expect(() => checkInstalledLock({ lock: mixed, installRoot })).toThrow(
        "Refusing installed symlink"
      )
    }))

  it("B-T7 an entry naming a non-GHCR registry is refused before fetching", async () =>
    temporary(async root => {
      const f = fixture(root)
      mkdirSync(join(root, "installed"))
      for (const registry of ["evil.example", "ghcr.io.evil.example"]) {
        const reference = { registry, repository: f.oci.oci.repository }
        expect(ociCertificateIdentityResolver(reference)).toBeNull()
        let fetched = false
        await expect(
          installConnectorsAtomically({
            lock: f.lockFor({ ...f.oci, oci: { ...f.oci.oci, registry } }),
            installRoot: join(root, "installed"),
            fetchImpl: async () => {
              fetched = true
              throw new Error("unexpected network")
            },
          })
        ).rejects.toThrow(/registry|trusted/i)
        expect(fetched).toBe(false)
      }
      expect(ociCertificateIdentityResolver(f.oci.oci)).toBe(identity)
      for (const repository of [
        "attacker/connector/ynab",
        "pdp-connect/connector/ynab/extra",
      ]) {
        expect(
          ociCertificateIdentityResolver({ registry: "ghcr.io", repository })
        ).toBeNull()
      }
    }))

  it("B-T8 generate-platform-registry output is unchanged by a mixed v2 lock", async () =>
    temporary(async root => {
      const f = fixture(root),
        legacy = {
          connectorId: "legacy",
          sourceFiles: {
            metadata: "legacy/manifest.json",
            script: "legacy/script.js",
          },
        }
      put(root, "package.json", '{"type":"module"}')
      put(
        root,
        "scripts/generate-platform-registry.js",
        readFileSync("scripts/generate-platform-registry.js")
      )
      put(
        root,
        "connectors/legacy/manifest.json",
        json({
          connector_id: "legacy",
          source_id: "legacy",
          name: "Legacy",
          consumer_metadata: {
            brand_domain: "example.com",
            default_scope: "legacy.data",
          },
        })
      )
      put(
        root,
        "src/lib/platform/registry.overlay.json",
        json({
          connectors: [{ connectorId: "legacy", showInConnectList: true }],
        })
      )
      const output = join(root, "src/lib/platform/registry.generated.ts")
      const generate = current => {
        put(root, "connectors/lock.json", json(current))
        execFileSync(process.execPath, [
          join(root, "scripts/generate-platform-registry.js"),
        ])
        return readFileSync(output)
      }
      const before = generate({
        lockVersion: "1.0",
        connectors: [legacy, f.tarball],
      })
      expect(
        generate({ lockVersion: "2.0", connectors: [legacy, f.oci] })
      ).toEqual(before)
    }))
})

describe("connector publication recovery", () => {
  it("recovers the previous tree after process exit between publication renames", async () =>
    temporary(async root => {
      const installRoot = join(root, "installed")
      put(installRoot, "lock.json", "previous lock")
      put(installRoot, "legacy/script.js", "previous connector")
      const before = tree(installRoot)
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { pathToFileURL } from "node:url";
      const installRoot = ${JSON.stringify(installRoot)};
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        const result = rename(from, to);
        if (from === installRoot && to.endsWith("previous")) process.exit(73);
        return result;
      };
      syncBuiltinESMExports();
      const { installConnectorsAtomically } = await import(pathToFileURL(${JSON.stringify(resolve("scripts/resolve-connectors.js"))}));
      await installConnectorsAtomically({ lock: { lockVersion: "2.0", connectors: [] }, installRoot, install: async () => ({}) });
    `,
        ],
        { encoding: "utf8" }
      )
      expect(result.status).toBe(73)
      expect(existsSync(installRoot)).toBe(false)
      // A prior publication may have exited after its final rename but before
      // cleanup. Its missing `next` distinguishes it from the interrupted one.
      put(
        root,
        ".installed-install-completed/owner.json",
        json({ installRoot, pid: result.pid })
      )
      put(root, ".installed-install-completed/previous/lock.json", "older lock")
      recoverInterruptedInstall(installRoot)
      expect(tree(installRoot)).toEqual(before)
      expect(readdirSync(root)).toEqual(["installed"])
    }))

  for (const rollbackFails of [false, true]) {
    it(
      rollbackFails
        ? "retains the previous bytes and reports their location when rollback fails"
        : "restores the previous tree when publication fails",
      async () =>
        temporary(async root => {
          const installRoot = join(root, "installed")
          put(installRoot, "lock.json", "previous lock")
          put(installRoot, "legacy/script.js", "previous connector")
          const before = tree(installRoot)
          // A child process confines the filesystem fault injection to this test.
          // Creating a competing destination reproduces the failed-rollback case.
          const result = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
        import fs from "node:fs";
        import { join } from "node:path";
        import { syncBuiltinESMExports } from "node:module";
        import { pathToFileURL } from "node:url";
        const installRoot = ${JSON.stringify(installRoot)};
        const rollbackFails = ${rollbackFails};
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if (from.endsWith("next") && to === installRoot) {
            if (rollbackFails) {
              fs.mkdirSync(installRoot);
              fs.writeFileSync(join(installRoot, "concurrent"), "other process");
            }
            throw new Error("injected publication failure");
          }
          return rename(from, to);
        };
        syncBuiltinESMExports();
        const { installConnectorsAtomically } = await import(pathToFileURL(${JSON.stringify(resolve("scripts/resolve-connectors.js"))}));
        try {
          await installConnectorsAtomically({
            lock: { lockVersion: "2.0", connectors: [] }, installRoot,
            install: async () => ({})
          });
          process.exitCode = 1;
        } catch (error) { console.log(error.message); }
      `,
            ],
            { encoding: "utf8" }
          )
          expect(result.status).toBe(0)
          expect(result.stderr).toBe("")
          if (rollbackFails) {
            const recovery = readdirSync(root).find(name =>
              name.startsWith(".installed-install-")
            )
            expect(recovery).toBeDefined()
            const previous = join(root, recovery, "previous")
            expect(tree(previous)).toEqual(before)
            expect(result.stdout).toContain(
              `previous bundle retained at ${previous}`
            )
            expect(readFileSync(join(installRoot, "concurrent"), "utf8")).toBe(
              "other process"
            )
          } else {
            expect(result.stdout).toContain("injected publication failure")
            expect(tree(installRoot)).toEqual(before)
            expect(readdirSync(root)).toEqual(["installed"])
          }
        })
    )
  }
})
