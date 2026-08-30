// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  artifactCertificateIdentityResolver,
  LOCKED_ARTIFACT_SOURCE,
  resolveIndexUrl,
} from "./resolve-connectors.js"

const lock = JSON.parse(readFileSync("connectors/lock.json", "utf8"))
const legacyArtifacts = lock.connectors.filter(connector =>
  connector.artifactUrl.startsWith("https://github.com/vana-com/")
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
      if (connector.artifactUrl.startsWith("https://github.com/vana-com/")) {
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
