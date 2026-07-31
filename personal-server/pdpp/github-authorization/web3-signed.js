import { createHash } from "node:crypto"
import { recoverMessageAddress } from "viem"

const WEB3_SIGNED_PREFIX = "Web3Signed "
const CLOCK_SKEW_SECONDS = 60
const MAX_PROOF_LIFETIME_SECONDS = 5 * 60

function bodyHash(body) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`
}

function parseHeader(authorization) {
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith(WEB3_SIGNED_PREFIX)
  ) {
    throw new Error("Missing Web3Signed authorization")
  }
  const signed = authorization.slice(WEB3_SIGNED_PREFIX.length)
  const separator = signed.indexOf(".")
  if (separator <= 0 || separator === signed.length - 1) {
    throw new Error("Malformed Web3Signed authorization")
  }
  const payloadBase64 = signed.slice(0, separator)
  const signature = signed.slice(separator + 1)
  if (!/^0x[0-9a-f]+$/i.test(signature)) {
    throw new Error("Malformed Web3Signed signature")
  }
  let payload
  try {
    payload = JSON.parse(
      Buffer.from(payloadBase64, "base64url").toString("utf8")
    )
  } catch {
    throw new Error("Malformed Web3Signed payload")
  }
  for (const field of ["aud", "method", "uri", "bodyHash"]) {
    if (typeof payload?.[field] !== "string") {
      throw new Error("Malformed Web3Signed payload")
    }
  }
  if (!Number.isInteger(payload?.iat) || !Number.isInteger(payload?.exp)) {
    throw new Error("Malformed Web3Signed payload")
  }
  return { payload, payloadBase64, signature }
}

/** Verify a fresh builder proof before returning an external PDPP credential. */
export async function verifyWeb3SignedRequester({
  authorization,
  expectedOrigin,
  expectedPath,
  method = "POST",
  body = "",
  now = () => Math.floor(Date.now() / 1000),
}) {
  const { payload, payloadBase64, signature } = parseHeader(authorization)
  if (
    payload.aud !== expectedOrigin ||
    payload.method !== method ||
    payload.uri !== expectedPath ||
    payload.bodyHash !== bodyHash(body)
  ) {
    throw new Error("Web3Signed authorization does not bind this request")
  }
  const timestamp = now()
  if (
    payload.iat < timestamp - CLOCK_SKEW_SECONDS ||
    payload.iat > timestamp + CLOCK_SKEW_SECONDS ||
    payload.exp < timestamp ||
    payload.exp < payload.iat ||
    payload.exp - payload.iat > MAX_PROOF_LIFETIME_SECONDS
  ) {
    throw new Error("Web3Signed authorization is stale")
  }
  try {
    return (
      await recoverMessageAddress({
        message: payloadBase64,
        signature,
      })
    ).toLowerCase()
  } catch {
    throw new Error("Web3Signed signature is invalid")
  }
}

export { bodyHash }
