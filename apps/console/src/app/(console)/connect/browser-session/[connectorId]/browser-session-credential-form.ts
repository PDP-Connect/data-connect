// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { StaticSecretSetup } from "../../../lib/ref-client.ts";
import {
  buildStaticSecretPayload,
  collectStaticSecretSetupFields,
} from "../../static-secret/[connectorId]/static-secret-payload.ts";

type FormReader = Pick<FormData, "get">;

export interface BrowserCredentialSubmission {
  readonly secret: string;
  readonly setupFields: Record<string, string>;
}

export type BrowserCredentialResult =
  | { readonly ok: true; readonly submission: BrowserCredentialSubmission }
  | {
      readonly error: string;
      readonly ok: false;
      readonly setupFields: Record<string, string>;
    };

/**
 * Applies the browser-session page's credential control to the existing
 * manifest-authored static-secret payload builder. Only a manifest-optional
 * capture may take the no-secret browser path. Required capture validates all
 * fields before the route creates or mutates a connection.
 */
export function browserCredentialSubmission(
  setup: StaticSecretSetup,
  formData: FormReader,
): BrowserCredentialResult | null {
  const remember = formData.get("remember_sign_in_details");
  if (setup.credential_capture.required === false && remember !== "1" && remember !== "true") {
    return null;
  }

  const setupFields = collectStaticSecretSetupFields(setup, formData);
  const payload = buildStaticSecretPayload(setup, formData);
  if (!payload.ok) {
    return { error: payload.error, ok: false, setupFields };
  }
  return {
    ok: true,
    submission: { secret: payload.secret, setupFields },
  };
}
