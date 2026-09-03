// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// data-connectors ships these runtime JavaScript entrypoints without .d.ts
// files. Console typechecks reference implementation setup-plan source, so
// keep the boundary explicit until the upstream package publishes declarations.
declare module "@pdpp/polyfill-connectors/connector-conformance-roster" {
  export const KNOWN_SCAFFOLD_CONNECTORS: readonly string[];
  export const PRODUCTION_READY_CONNECTORS: readonly string[];
}

declare module "@pdpp/polyfill-connectors/credential-probe" {
  export type CredentialValidationMode = any;
  export const credentialValidationMode: any;
}

declare module "@pdpp/polyfill-connectors/static-secret-credential-capture" {
  export type NormalizedStaticSecretCredentialCapture = any;
  export type NormalizedStaticSecretField = any;
  export type StaticSecretCredentialCaptureFieldLike = any;
  export type StaticSecretFieldType = any;
  export const normalizeStaticSecretCredentialCapture: any;
}

declare module "@pdpp/polyfill-connectors/static-secret-injection" {
  export const STATIC_SECRET_CONNECTOR_REGISTRY: Readonly<Record<string, unknown>>;
}
