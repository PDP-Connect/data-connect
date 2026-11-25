// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sign-in details of a browser sign-in service, as the manifest names them.
 *
 * A missing setup descriptor is meaningful: the person signs in in the browser
 * and nothing is saved, so the page shows no fields at all. The words on the
 * page come from `sources/add/connect-copy.ts`, not from here.
 */

import type { StaticSecretSetup, StaticSecretSetupField } from "./ref-client.ts";

export interface BrowserSignInCapture {
  /** Name of the form field that carries the choice to save the details. Read by the start route. */
  readonly checkboxName: "remember_sign_in_details";
  readonly fields: readonly StaticSecretSetupField[];
  /** Details are needed to start. When false, they are an opt-in. */
  readonly required: boolean;
}

export function browserSignInCapture(setup: StaticSecretSetup | null): BrowserSignInCapture | null {
  if (!setup) {
    return null;
  }
  return {
    checkboxName: "remember_sign_in_details",
    fields: setup.credential_capture.fields,
    required: setup.credential_capture.required,
  };
}
