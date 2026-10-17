// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AssistanceField } from "../../lib/run-assistance.ts"
import type { StaticSecretSetup } from "../../lib/ref-client.ts"

export interface CredentialInteractionField {
  autocomplete: string | null
  format: "email" | "password" | "text"
  label: string
  name: string
  required: boolean
}

function readableEnvLabel(name: string): string {
  const words = name.split(/[_\-\s]+/).filter(Boolean)
  return (
    words
      .map((word, index) => {
        const lower = word.toLowerCase()
        if (index > 0 && ["api", "id", "otp", "url"].includes(lower))
          return lower.toUpperCase()
        return index === 0 ? lower[0]?.toUpperCase() + lower.slice(1) : lower
      })
      .join(" ") || "Credential"
  )
}

export function projectCredentialInteraction(
  fields: readonly AssistanceField[],
  setup: StaticSecretSetup | null
): {
  fields: CredentialInteractionField[]
  message: string
  submitLabel: string | null
} {
  const remaining = new Map(fields.map(field => [field.name, field]))
  const projected: CredentialInteractionField[] = []
  for (const field of setup?.credential_capture.fields ?? []) {
    const matchedName = field.env?.find(alias => remaining.has(alias))
    if (!matchedName) continue
    const matched = remaining.get(matchedName)!
    remaining.delete(matchedName)
    projected.push({
      autocomplete: field.autocomplete,
      format: field.type,
      label: field.label,
      name: matched.name,
      required: matched.required,
    })
  }
  for (const field of remaining.values()) {
    projected.push({
      autocomplete: null,
      format: field.format,
      label:
        field.label && field.label !== field.name
          ? field.label
          : readableEnvLabel(field.name),
      name: field.name,
      required: field.required,
    })
  }
  return {
    fields: projected,
    message: "Enter the requested details for this run.",
    submitLabel:
      projected.length > remaining.size
        ? (setup?.credential_capture.submit_label ?? null)
        : null,
  }
}
