// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { verifyMessage } from "viem/utils"
import type { PdppAuthorizationDetail } from "./pdppAuthorization"

export class PdppAuthorizationProofError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PdppAuthorizationProofError"
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, sortJson((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

/**
 * EIP-191 message signed by an external PDPP builder before it creates the
 * Session Relay deep link. The session ID prevents the same proof from being
 * moved to another relay session.
 */
export function createPdppAuthorizationProofMessage(
  sessionId: string,
  authorizationDetails: PdppAuthorizationDetail[]
): string {
  return JSON.stringify(
    sortJson({
      authorization_details: authorizationDetails,
      session_id: sessionId,
    })
  )
}

export async function verifyPdppAuthorizationProof({
  sessionId,
  authorizationDetails,
  signature,
  builderAddress,
}: {
  sessionId: string
  authorizationDetails: PdppAuthorizationDetail[]
  signature: string | undefined
  builderAddress: string
}): Promise<void> {
  if (!signature) {
    throw new PdppAuthorizationProofError(
      "The PDPP authorization request is missing the builder signature. Please restart the flow from the app."
    )
  }

  try {
    const valid = await verifyMessage({
      address: builderAddress as `0x${string}`,
      message: createPdppAuthorizationProofMessage(
        sessionId,
        authorizationDetails
      ),
      signature: signature as `0x${string}`,
    })
    if (valid) return
  } catch {
    // Malformed addresses and signatures are invalid proofs.
  }

  throw new PdppAuthorizationProofError(
    "The PDPP authorization request does not match the verified builder signature. Please restart the flow from the app."
  )
}
