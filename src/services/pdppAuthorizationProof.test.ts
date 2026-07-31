import { describe, expect, it } from "vitest"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import {
  createPdppAuthorizationProofMessage,
  PdppAuthorizationProofError,
  verifyPdppAuthorizationProof,
} from "./pdppAuthorizationProof"
import type { PdppAuthorizationDetail } from "./pdppAuthorization"

const details: PdppAuthorizationDetail[] = [
  {
    type: "https://pdpp.org/data-access",
    source: { kind: "connector", id: "github" },
    access_mode: "continuous",
    purpose_code: "https://example.test/purpose",
    retention: { max_duration: "P30D", on_expiry: "delete" },
    streams: [
      {
        name: "repositories",
        fields: ["name", "description"],
      },
    ],
  },
]

async function signedProof(sessionId: string) {
  const account = privateKeyToAccount(generatePrivateKey())
  const signature = await account.signMessage({
    message: createPdppAuthorizationProofMessage(sessionId, details),
  })
  return { account, signature }
}

describe("PDPP authorization proof", () => {
  it("accepts an EIP-191 signature from the claimed builder", async () => {
    const { account, signature } = await signedProof("session-1")

    await expect(
      verifyPdppAuthorizationProof({
        sessionId: "session-1",
        authorizationDetails: details,
        signature,
        builderAddress: account.address,
      })
    ).resolves.toBeUndefined()
  })

  it("canonicalizes object keys recursively", () => {
    const reordered = [
      {
        streams: [{ fields: ["name", "description"], name: "repositories" }],
        retention: { on_expiry: "delete", max_duration: "P30D" },
        purpose_code: "https://example.test/purpose",
        access_mode: "continuous",
        source: { id: "github", kind: "connector" },
        type: "https://pdpp.org/data-access",
      },
    ] as PdppAuthorizationDetail[]

    expect(createPdppAuthorizationProofMessage("session-1", reordered)).toBe(
      createPdppAuthorizationProofMessage("session-1", details)
    )
  })

  it("rejects a request with no proof", async () => {
    const account = privateKeyToAccount(generatePrivateKey())

    await expect(
      verifyPdppAuthorizationProof({
        sessionId: "session-1",
        authorizationDetails: details,
        signature: undefined,
        builderAddress: account.address,
      })
    ).rejects.toThrow(PdppAuthorizationProofError)
  })

  it("rejects tampered authorization details", async () => {
    const { account, signature } = await signedProof("session-1")
    const tampered = structuredClone(details)
    tampered[0].purpose_code = "https://attacker.example/purpose"

    await expect(
      verifyPdppAuthorizationProof({
        sessionId: "session-1",
        authorizationDetails: tampered,
        signature,
        builderAddress: account.address,
      })
    ).rejects.toThrow("does not match the verified builder signature")
  })

  it("rejects a proof moved to another relay session", async () => {
    const { account, signature } = await signedProof("session-1")

    await expect(
      verifyPdppAuthorizationProof({
        sessionId: "session-2",
        authorizationDetails: details,
        signature,
        builderAddress: account.address,
      })
    ).rejects.toThrow("does not match the verified builder signature")
  })

  it("rejects a proof from a different builder", async () => {
    const { signature } = await signedProof("session-1")
    const otherBuilder = privateKeyToAccount(generatePrivateKey())

    await expect(
      verifyPdppAuthorizationProof({
        sessionId: "session-1",
        authorizationDetails: details,
        signature,
        builderAddress: otherBuilder.address,
      })
    ).rejects.toThrow("does not match the verified builder signature")
  })
})
