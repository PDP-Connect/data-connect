// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ConnectorInstanceCredentialError as ConnectorInstanceCredentialErrorClass } from "./connector-instance-credential-store.ts";

export const ConnectorInstanceCredentialError = ConnectorInstanceCredentialErrorClass;

export class StaticSecretRunCredentialError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StaticSecretRunCredentialError";
    this.code = code;
  }
}

export interface RecoveredCredential {
  credentialKind: string;
  secret: string;
}

export interface StaticSecretCredentialStore {
  recoverSecret: (args: { connectorInstanceId: string; ownerSubjectId: string }) => Promise<RecoveredCredential>;
}

interface CaptureField {
  readonly env: readonly string[];
  readonly name: string;
  readonly required: boolean;
  readonly secret: boolean;
}

interface StaticSecretProfile {
  readonly credentialKind: string;
  readonly fields: readonly CaptureField[];
  readonly required: boolean;
}

interface InjectionMapping {
  readonly bundleEnvAliases?: Readonly<Record<string, readonly string[]>>;
  readonly credentialKind: string;
  readonly secretBundleFields?: readonly string[];
  readonly requiredBundleFields?: readonly string[];
  readonly secretEnvAliases?: readonly string[];
  readonly setupEnvAliases?: Readonly<Record<string, readonly string[]>>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonblank(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertRunOwnerSubjectId(ownerSubjectId: unknown): asserts ownerSubjectId is string {
  if (typeof ownerSubjectId !== "string" || ownerSubjectId.trim().length === 0) {
    throw new StaticSecretRunCredentialError(
      "owner_subject_required",
      "A nonblank ownerSubjectId is required to resolve a static-secret run env.",
    );
  }
}

function staticSecretProfile(connectorId: string, manifest: unknown): StaticSecretProfile | null {
  const setup = record(record(manifest)?.setup);
  if (setup?.modality !== "static_secret") {
    return null;
  }
  const capture = record(setup.credential_capture);
  const credentialKind = nonblank(capture?.kind) ?? nonblank(capture?.credential_kind);
  if (!capture || !credentialKind || !Array.isArray(capture.fields)) {
    throw new StaticSecretRunCredentialError(
      "static_secret_manifest_invalid",
      `Connector '${connectorId}' declares static_secret setup without a valid credential_capture contract.`,
    );
  }
  const fields: CaptureField[] = [];
  for (const value of capture.fields) {
    const field = record(value);
    const name = nonblank(field?.name);
    if (!field || !name) {
      throw new StaticSecretRunCredentialError(
        "static_secret_manifest_invalid",
        `Connector '${connectorId}' declares an invalid credential_capture field.`,
      );
    }
    const env = Array.isArray(field.env)
      ? field.env.map(nonblank).filter((alias): alias is string => alias !== null)
      : [];
    const secret = field.secret === true || field.type === "password";
    if (secret && env.length === 0) {
      throw new StaticSecretRunCredentialError(
        "static_secret_manifest_invalid",
        `Connector '${connectorId}' declares secret field '${name}' without env aliases.`,
      );
    }
    fields.push({ env, name, required: field.required !== false, secret });
  }
  if (!fields.some((field) => field.secret)) {
    throw new StaticSecretRunCredentialError(
      "static_secret_manifest_invalid",
      `Connector '${connectorId}' declares static_secret setup without a secret field.`,
    );
  }
  return { credentialKind, fields, required: capture.required !== false };
}

export function isStaticSecretProfileManifest(manifest: unknown): boolean {
  try {
    return staticSecretProfile("manifest-check", manifest) !== null;
  } catch {
    return false;
  }
}

function defaultMapping(profile: StaticSecretProfile): InjectionMapping {
  const secretFields = profile.fields.filter((field) => field.secret);
  const setupFields = profile.fields.filter((field) => !field.secret);
  if (profile.credentialKind === "secret_bundle") {
    return {
      bundleEnvAliases: Object.fromEntries(profile.fields.map((field) => [field.name, field.env])),
      credentialKind: profile.credentialKind,
      secretBundleFields: profile.fields.map((field) => field.name),
      requiredBundleFields: profile.fields.filter((field) => field.required).map((field) => field.name),
    };
  }
  const setupEnvAliases = Object.fromEntries(setupFields.map((field) => [field.name, field.env]));
  if (profile.credentialKind === "username_password") {
    return {
      bundleEnvAliases: Object.fromEntries(secretFields.map((field) => [field.name, field.env])),
      credentialKind: profile.credentialKind,
      requiredBundleFields: secretFields.filter((field) => field.required).map((field) => field.name),
      secretBundleFields: secretFields.map((field) => field.name),
      setupEnvAliases,
    };
  }
  if (secretFields.length === 1) {
    return {
      credentialKind: profile.credentialKind,
      secretEnvAliases: secretFields[0]?.env ?? [],
      setupEnvAliases,
    };
  }
  return {
    bundleEnvAliases: Object.fromEntries(secretFields.map((field) => [field.name, field.env])),
    credentialKind: profile.credentialKind,
    secretBundleFields: secretFields.map((field) => field.name),
    requiredBundleFields: secretFields.filter((field) => field.required).map((field) => field.name),
    setupEnvAliases,
  };
}

function recoveredMapping(
  connectorId: string,
  profile: StaticSecretProfile,
  recovered: RecoveredCredential,
): InjectionMapping {
  const current = defaultMapping(profile);
  if (recovered.credentialKind === current.credentialKind) {
    return current;
  }
  throw new StaticSecretRunCredentialError(
    "credential_kind_mismatch",
    `Connector '${connectorId}' expects credential kind '${current.credentialKind}', but recovered '${recovered.credentialKind}'.`,
  );
}

function parseCredentialBundle(connectorId: string, secret: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new StaticSecretRunCredentialError(
      "recovered_secret_bundle_invalid",
      `Connector '${connectorId}' expects a sealed JSON credential bundle.`,
    );
  }
  const source = record(parsed);
  if (!source) {
    throw new StaticSecretRunCredentialError(
      "recovered_secret_bundle_invalid",
      `Connector '${connectorId}' expects a sealed JSON credential bundle object.`,
    );
  }
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, value]) => {
      const cleaned = nonblank(value);
      return cleaned ? [[key, cleaned]] : [];
    }),
  );
}

function setAliases(target: Record<string, string>, aliases: readonly string[] | undefined, value: string): void {
  for (const alias of aliases ?? []) {
    target[alias] = value;
  }
}

function buildSecretEnv(
  connectorId: string,
  profile: StaticSecretProfile,
  mapping: InjectionMapping,
  recovered: RecoveredCredential,
  sourceBinding: unknown,
): Record<string, string> {
  if (typeof recovered.secret !== "string" || recovered.secret.length === 0) {
    throw new StaticSecretRunCredentialError(
      "recovered_secret_invalid",
      `Cannot inject an empty credential for '${connectorId}'.`,
    );
  }
  const fragment: Record<string, string> = {};
  let includeSetupFields = true;
  if (mapping.secretEnvAliases) {
    if (recovered.secret === "{}" && !profile.required) {
      includeSetupFields = false;
    } else {
      setAliases(fragment, mapping.secretEnvAliases, recovered.secret);
    }
  }
  if (mapping.bundleEnvAliases) {
    const values = parseCredentialBundle(connectorId, recovered.secret);
    const requiredFields = new Set(mapping.requiredBundleFields ?? []);
    if (!profile.required && Object.keys(values).length === 0) {
      includeSetupFields = false;
    }
    if (profile.required && !(mapping.secretBundleFields ?? []).some((fieldName) => values[fieldName])) {
      throw new StaticSecretRunCredentialError(
        "recovered_secret_bundle_field_missing",
        `Connector '${connectorId}' credential bundle contains no secret fields.`,
      );
    }
    for (const [fieldName, aliases] of Object.entries(mapping.bundleEnvAliases)) {
      const value = values[fieldName];
      if (!value) {
        if (requiredFields.has(fieldName)) {
          throw new StaticSecretRunCredentialError(
            "recovered_secret_bundle_field_missing",
            `Connector '${connectorId}' credential bundle is missing required field '${fieldName}'.`,
          );
        }
        continue;
      }
      setAliases(fragment, aliases, value);
    }
  }
  if (includeSetupFields) {
    const setupFields = record(record(sourceBinding)?.setup_fields) ?? {};
    for (const [fieldName, aliases] of Object.entries(mapping.setupEnvAliases ?? {})) {
      const value = nonblank(setupFields[fieldName]);
      if (value) {
        setAliases(fragment, aliases, value);
      }
    }
  }
  return fragment;
}

/** Resolve one connection's secret env solely from its registered profile manifest. */
export async function resolveStaticSecretRunEnv({
  connectorId,
  connectorInstanceId,
  ownerSubjectId,
  sourceBinding,
  credentialStore,
  manifest,
}: {
  connectorId: string;
  connectorInstanceId: string;
  credentialStore: StaticSecretCredentialStore | null | undefined;
  manifest: unknown;
  ownerSubjectId: string;
  sourceBinding?: unknown;
}): Promise<Record<string, string> | null> {
  const profile = staticSecretProfile(connectorId, manifest);
  if (!profile) {
    return null;
  }
  if (!credentialStore) {
    throw new StaticSecretRunCredentialError(
      "credential_store_required",
      "A connector-instance credential store is required to resolve a static-secret run env.",
    );
  }
  assertRunOwnerSubjectId(ownerSubjectId);
  const binding = record(sourceBinding);
  const browserSessionSource = binding?.kind === "browser_collector" || binding?.kind === "browser_enrollment_shell";
  let recovered: RecoveredCredential;
  try {
    recovered = await credentialStore.recoverSecret({
      connectorInstanceId,
      ownerSubjectId,
    });
  } catch (err) {
    if (
      (browserSessionSource || !profile.required) &&
      err instanceof ConnectorInstanceCredentialError &&
      (err.code === "credential_not_found" || err.code === "credential_revoked" || err.code === "credential_rejected")
    ) {
      return null;
    }
    throw err;
  }
  return buildSecretEnv(
    connectorId,
    profile,
    recoveredMapping(connectorId, profile, recovered),
    recovered,
    sourceBinding,
  );
}
