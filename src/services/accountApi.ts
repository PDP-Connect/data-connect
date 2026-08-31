// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { configuredServiceUrl } from "@/config/service-endpoints"

function accountUrl(): string {
  return configuredServiceUrl(
    "VITE_ACCOUNT_URL",
    import.meta.env.VITE_ACCOUNT_URL
  )
}

export async function signMessage(
  masterKeySignature: string,
  message: string
): Promise<string> {
  const res = await tauriFetch(`${accountUrl()}/api/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      masterKeySignature,
      message,
      type: "personal_sign",
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Sign failed (${res.status}): ${text}`)
  }
  const { signature } = await res.json()
  return signature
}

export async function signTypedData(
  masterKeySignature: string,
  typedData: Record<string, unknown>
): Promise<string> {
  const res = await tauriFetch(`${accountUrl()}/api/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      masterKeySignature,
      typedData,
      type: "eth_signTypedData_v4",
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Sign failed (${res.status}): ${text}`)
  }
  const { signature } = await res.json()
  return signature
}
