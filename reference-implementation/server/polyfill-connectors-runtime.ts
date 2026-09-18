// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional compatibility boundary for the legacy polyfill helper surface.
 *
 * The Docker reference image deliberately does not contain the
 * `@pdpp/polyfill-connectors` package: executable connectors are installed
 * from the signed catalog instead. Development and conformance runs may still
 * have that package, so this module uses it when available and supplies the
 * safe empty/default behavior needed before the first catalog install when it
 * is not.
 */

import type { ManualUploadValidationResult } from "@pdpp/polyfill-connectors/manual-upload-validation";
import type { ParsedCoverageDiagnosticsStateSnapshot } from "@pdpp/polyfill-connectors/local-source-inventory";

export type { ManualUploadValidationResult };

export interface PolyfillManifestEntry {
  readonly file: string;
  readonly manifest: Record<string, unknown>;
}

export type StaticSecretFieldType = "email" | "password" | "text";

export interface StaticSecretCredentialCaptureFieldLike {
  readonly autocomplete?: string | null;
  readonly description?: string | null;
  readonly env?: readonly string[] | null;
  readonly help_text?: string | null;
  readonly help_url?: string | null;
  readonly identity?: boolean | null;
  readonly label?: string | null;
  readonly name?: string | null;
  readonly placeholder?: string | null;
  readonly required?: boolean | null;
  readonly secret?: boolean | null;
  readonly type?: string | null;
}

export interface StaticSecretCredentialCaptureLike {
  readonly description?: string | null;
  readonly fields?: readonly StaticSecretCredentialCaptureFieldLike[] | null;
  readonly kind?: string | null;
  readonly credential_kind?: string | null;
  readonly label?: string | null;
  readonly required?: boolean | null;
  readonly submit_label?: string | null;
}

export interface NormalizedStaticSecretField {
  readonly autocomplete: string | null;
  readonly description: string | null;
  readonly env: readonly string[];
  readonly helpText: string | null;
  readonly helpUrl: string | null;
  readonly identity: boolean;
  readonly label: string;
  readonly name: string;
  readonly placeholder: string | null;
  readonly required: boolean;
  readonly secret: boolean;
  readonly type: StaticSecretFieldType;
}

export interface NormalizedStaticSecretCredentialCapture {
  readonly description: string | null;
  readonly fields: readonly NormalizedStaticSecretField[];
  readonly kind: string;
  readonly label: string;
  readonly required: boolean;
  readonly submitLabel: string | null;
}

export class StaticSecretCredentialCaptureError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StaticSecretCredentialCaptureError";
    this.code = code;
  }
}

export type CredentialValidationMode = "synchronous" | "first_sync";

export interface ResolvedConfigOption {
  readonly defaultValue: boolean | number | string | readonly string[];
  readonly description: string;
  readonly enumValues: readonly string[] | null;
  readonly maximum: number | null;
  readonly minimum: number | null;
  readonly optionKind: "collection_scope" | "transport";
  readonly optionKey: string;
  readonly platformClassified: boolean;
  readonly type: "boolean" | "integer" | "string" | "string_array";
}

export interface ResolvedConnectorOptionsSchema {
  readonly connectorKey: string;
  readonly description: string;
  readonly options: readonly ResolvedConfigOption[];
}

export interface ProviderAuthManifestLike {
  readonly capabilities?: {
    readonly auth?: Record<string, unknown> | null;
  } | null;
  readonly connector_id?: string | null;
  readonly connector_key?: string | null;
}

export type DeploymentConfigResolver = (args: {
  readonly identityGroup: string;
  readonly logicalKey: string;
  readonly envAlias?: string | null;
}) => Promise<string | null>;

export interface ProviderAuthTokens {
  readonly accessToken: string;
  readonly expiresAt?: string | null;
  readonly refreshToken?: string | null;
  readonly tokenKind: string;
}

export interface ProviderAccount {
  readonly accountId: string;
  readonly displayLabel?: string | null;
  readonly sourceBinding?: Record<string, unknown> | null;
}

export interface ProviderAuthAdapter {
  readonly exchangeCode: (args: Record<string, unknown>) => Promise<ProviderAuthTokens | null>;
  readonly initiateAuthorization: (args: Record<string, unknown>) => Promise<{ authorizationUrl: string }>;
  readonly runInventoryOrTest: (args: Record<string, unknown>) => Promise<{
    accounts: readonly ProviderAccount[];
    persistenceContext?: Readonly<Record<string, unknown>>;
  }>;
  readonly storeTokens: (args: Record<string, unknown>) => Promise<Record<string, string>>;
}

interface OptionalModuleMap {
  readonly browserPolicy: Record<string, unknown> | null;
  readonly browserHandoff: Record<string, unknown> | null;
  readonly browserLaunch: Record<string, unknown> | null;
  readonly capture: Record<string, unknown> | null;
  readonly configKinds: Record<string, unknown> | null;
  readonly credentialProbe: Record<string, unknown> | null;
  readonly credentialProbeTransport: Record<string, unknown> | null;
  readonly coverage: Record<string, unknown> | null;
  readonly injection: Record<string, unknown> | null;
  readonly manifests: Record<string, unknown> | null;
  readonly manualUpload: Record<string, unknown> | null;
  readonly ntfy: Record<string, unknown> | null;
  readonly options: Record<string, unknown> | null;
  readonly resolve: Record<string, unknown> | null;
  readonly roster: Record<string, unknown> | null;
}

const optionalRequire = (() => {
  if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") {
    return null;
  }
  const moduleApi = process.getBuiltinModule("module") as {
    createRequire: (url: string | URL) => NodeRequire;
  };
  return moduleApi.createRequire(import.meta.url);
})();

function requireOptional(specifier: string): Record<string, unknown> | null {
  if (!optionalRequire) {
    return null;
  }
  try {
    return optionalRequire(specifier) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")) {
      return null;
    }
    throw error;
  }
}

const optionalModules: OptionalModuleMap = {
  browserHandoff: requireOptional("@pdpp/polyfill-connectors/browser-handoff"),
  browserLaunch: requireOptional("@pdpp/polyfill-connectors/browser-launch"),
  browserPolicy: requireOptional("@pdpp/polyfill-connectors/browser-surface-policy"),
  capture: requireOptional("@pdpp/polyfill-connectors/static-secret-credential-capture"),
  configKinds: requireOptional("@pdpp/polyfill-connectors/connector-config-option-kind-registry"),
  credentialProbe: requireOptional("@pdpp/polyfill-connectors/credential-probe"),
  credentialProbeTransport: requireOptional("@pdpp/polyfill-connectors/credential-probe-transport"),
  coverage: requireOptional("@pdpp/polyfill-connectors/local-source-inventory"),
  injection: requireOptional("@pdpp/polyfill-connectors/static-secret-injection"),
  manifests: requireOptional("@pdpp/polyfill-connectors/manifests"),
  manualUpload: requireOptional("@pdpp/polyfill-connectors/manual-upload-validation"),
  ntfy: requireOptional("@pdpp/polyfill-connectors/ntfy"),
  options: requireOptional("@pdpp/polyfill-connectors/connector-options-schema"),
  resolve: requireOptional("@pdpp/polyfill-connectors/resolve"),
  roster: requireOptional("@pdpp/polyfill-connectors/connector-conformance-roster"),
};

export function readPolyfillManifests(): readonly PolyfillManifestEntry[] {
  const read = optionalModules.manifests?.readPolyfillManifests;
  return typeof read === "function" ? (read() as readonly PolyfillManifestEntry[]) : [];
}

export function resolveConnectorImplementation(connectorId: string): {
  readonly brandIcon: string;
  readonly entry: string;
  readonly manifest: Record<string, unknown>;
} {
  const resolve = optionalModules.resolve?.resolveConnectorImplementation;
  if (typeof resolve === "function") {
    return resolve(connectorId) as {
      readonly brandIcon: string;
      readonly entry: string;
      readonly manifest: Record<string, unknown>;
    };
  }
  const error = new Error(`No catalog-installed connector implementation is available for ${connectorId}`) as Error & {
    code: string;
  };
  error.code = "ERR_PDPP_CONNECTOR_IMPLEMENTATION_NOT_FOUND";
  throw error;
}

export const PRODUCTION_READY_CONNECTORS: Readonly<Record<string, { readonly testFile: string }>> =
  (optionalModules.roster?.PRODUCTION_READY_CONNECTORS as Readonly<Record<string, { readonly testFile: string }>> | undefined) ?? {};
export const KNOWN_SCAFFOLD_CONNECTORS: readonly string[] =
  (optionalModules.roster?.KNOWN_SCAFFOLD_CONNECTORS as readonly string[] | undefined) ?? [];

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeStaticSecretCredentialCapture(
  connectorKey: string,
  capture: StaticSecretCredentialCaptureLike | null | undefined
): NormalizedStaticSecretCredentialCapture | null {
  const normalize = optionalModules.capture?.normalizeStaticSecretCredentialCapture;
  if (typeof normalize === "function") {
    return normalize(connectorKey, capture) as NormalizedStaticSecretCredentialCapture | null;
  }
  if (!capture || typeof capture !== "object") {
    return null;
  }
  const kind = cleanString(capture.kind) ?? cleanString(capture.credential_kind);
  const fields = Array.isArray(capture.fields) ? capture.fields : [];
  const normalized = fields.flatMap((value): NormalizedStaticSecretField[] => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const field = value as StaticSecretCredentialCaptureFieldLike;
    const name = cleanString(field.name);
    const label = cleanString(field.label);
    const type = cleanString(field.type);
    const env = Array.isArray(field.env) ? field.env.filter((item): item is string => cleanString(item) !== null) : [];
    const secret = field.secret === true || type === "password";
    if (!(name && label && env.length > 0 && (type === "email" || type === "password" || type === "text"))) {
      if (secret) {
        throw new StaticSecretCredentialCaptureError(
          "invalid_static_secret_capture",
          `Connector '${connectorKey}' declares an invalid static-secret field.`
        );
      }
      return [];
    }
    return [
      {
        autocomplete: cleanString(field.autocomplete),
        description: cleanString(field.description),
        env,
        helpText: cleanString(field.help_text),
        helpUrl: cleanString(field.help_url),
        identity: field.identity === true,
        label,
        name,
        placeholder: cleanString(field.placeholder),
        required: field.required !== false,
        secret,
        type,
      },
    ];
  });
  if (!(kind && normalized.some((field) => field.secret))) {
    return null;
  }
  return {
    description: cleanString(capture.description),
    fields: normalized,
    kind,
    label: cleanString(capture.label) ?? kind,
    required: capture.required !== false,
    submitLabel: cleanString(capture.submit_label),
  };
}

export function credentialValidationMode(connectorKey: string): CredentialValidationMode {
  const resolve = optionalModules.credentialProbe?.credentialValidationMode;
  return typeof resolve === "function" ? (resolve(connectorKey) as CredentialValidationMode) : "first_sync";
}

export function hasCredentialProbe(connectorKey: string): boolean {
  const has = optionalModules.credentialProbe?.hasCredentialProbe;
  return typeof has === "function" ? has(connectorKey) === true : false;
}

export function resolveEnforcedOptionKind(connectorKey: string, optionKey: string): "collection_scope" | "transport" {
  const resolve = optionalModules.configKinds?.resolveEnforcedOptionKind;
  return typeof resolve === "function" ? (resolve(connectorKey, optionKey) as "collection_scope" | "transport") : "collection_scope";
}

export function platformOptionKind(connectorKey: string, optionKey: string): "collection_scope" | "transport" | null {
  const resolve = optionalModules.configKinds?.platformOptionKind;
  return typeof resolve === "function" ? (resolve(connectorKey, optionKey) as "collection_scope" | "transport" | null) : null;
}

export function connectorOptionsSchema(connectorKey: string | null): ResolvedConnectorOptionsSchema | null {
  const resolve = optionalModules.options?.connectorOptionsSchema;
  return typeof resolve === "function" ? (resolve(connectorKey) as ResolvedConnectorOptionsSchema | null) : null;
}

// `requireOptional` above loads every other optional module synchronously
// via `require()`, which is fine for modules whose registration is entirely
// internal. Provider-auth adapters are different: `registerProviderAuthAdapter`
// is also called directly by test/connector code that reaches it through a
// plain ESM `import` of the same package specifier. Node does not guarantee
// that specifier resolves to the same module instance across the `require()`
// and `import()` boundaries under every loader (observed split under tsx),
// so a `require()`-loaded copy here can silently miss registrations made via
// `import` elsewhere, each side holding its own adapter registry Map. Using
// `import()` — the same loading path external registrants use — keeps this
// resolver looking at the one registry they actually wrote to.
let providerAdaptersModulePromise: Promise<Record<string, unknown> | null> | null = null;

function loadProviderAdaptersModule(): Promise<Record<string, unknown> | null> {
  providerAdaptersModulePromise ??= import("@pdpp/polyfill-connectors/provider-auth-adapters").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")) {
      return null;
    }
    throw error;
  });
  return providerAdaptersModulePromise;
}

export async function resolveProviderAuthAdapter(kind: string): Promise<ProviderAuthAdapter | null> {
  const module = await loadProviderAdaptersModule();
  const resolve = module?.resolveProviderAuthAdapter;
  return typeof resolve === "function" ? ((await resolve(kind)) as ProviderAuthAdapter | null) : null;
}

export function parseCoverageDiagnosticsStateSnapshot(
  connectorId: string,
  state: unknown
): ParsedCoverageDiagnosticsStateSnapshot {
  const parse = optionalModules.coverage?.parseCoverageDiagnosticsStateSnapshot;
  return typeof parse === "function"
    ? (parse(connectorId, state) as ParsedCoverageDiagnosticsStateSnapshot)
    : {
        duplicateStores: [],
        hasAuthoritativeInventory: false,
        hasCommittedSnapshot: false,
        malformed: state !== null && state !== undefined,
        missingStores: [],
        rows: [],
        unexpectedStores: [],
      };
}

export async function loadStaticSecretInjectionHelpers(): Promise<{
  readonly buildConnectionScopedSecretEnv: (connectorId: string, recovered: unknown, sourceBinding?: unknown) => Record<string, string>;
  readonly isStaticSecretCaptureOptional: (connectorId: string) => boolean;
  readonly isStaticSecretConnector: (connectorId: string) => boolean;
}> {
  const module = optionalModules.injection;
  return {
    buildConnectionScopedSecretEnv:
      (module?.buildConnectionScopedSecretEnv as
        | ((connectorId: string, recovered: unknown, sourceBinding?: unknown) => Record<string, string>)
        | undefined) ??
      (() => {
        throw new Error("Static-secret connector runtime support is unavailable until a connector is installed.");
      }),
    isStaticSecretCaptureOptional:
      (module?.isStaticSecretCaptureOptional as ((connectorId: string) => boolean) | undefined) ?? (() => false),
    isStaticSecretConnector: (module?.isStaticSecretConnector as ((connectorId: string) => boolean) | undefined) ?? (() => false),
  };
}

export async function loadCredentialProbeHelpers(): Promise<{
  readonly createLiveCredentialProbeTransport: (connectorId: string) => object;
  readonly hasCredentialProbe: (connectorId: string) => boolean;
  readonly probeCredential: (args: Record<string, unknown>) => Promise<{ identity: string; detail?: string | null }>;
}> {
  const module = optionalModules.credentialProbe;
  const transportModule = optionalModules.credentialProbeTransport;
  return {
    createLiveCredentialProbeTransport:
      (transportModule?.createLiveCredentialProbeTransport as ((connectorId: string) => object) | undefined) ?? (() => ({})),
    hasCredentialProbe: (module?.hasCredentialProbe as ((connectorId: string) => boolean) | undefined) ?? (() => false),
    probeCredential:
      (module?.probeCredential as
        | ((args: Record<string, unknown>) => Promise<{ identity: string; detail?: string | null }>)
        | undefined) ??
      (async () => {
        throw new Error("Credential probing is unavailable until a connector is installed.");
      }),
  };
}

export async function loadManualUploadValidationHelpers(): Promise<{
  readonly validateManualUploadArtifactByKind?: (...args: readonly unknown[]) => unknown;
  readonly validateManualUploadArtifactFromFileByKind?: (...args: readonly unknown[]) => Promise<unknown>;
}> {
  const validateManualUploadArtifactByKind = optionalModules.manualUpload?.validateManualUploadArtifactByKind as
    | ((...args: readonly unknown[]) => unknown)
    | undefined;
  const validateManualUploadArtifactFromFileByKind = optionalModules.manualUpload?.validateManualUploadArtifactFromFileByKind as
    | ((...args: readonly unknown[]) => Promise<unknown>)
    | undefined;
  return {
    ...(validateManualUploadArtifactByKind ? { validateManualUploadArtifactByKind } : {}),
    ...(validateManualUploadArtifactFromFileByKind ? { validateManualUploadArtifactFromFileByKind } : {}),
  };
}

export function validateManualUploadArtifactByKind(
  ...args: readonly unknown[]
): ManualUploadValidationResult | null {
  const validate = optionalModules.manualUpload?.validateManualUploadArtifactByKind;
  return typeof validate === "function" ? (validate(...args) as ManualUploadValidationResult | null) : null;
}

export async function validateManualUploadArtifactFromFileByKind(
  ...args: readonly unknown[]
): Promise<ManualUploadValidationResult | null> {
  const validate = optionalModules.manualUpload?.validateManualUploadArtifactFromFileByKind;
  return typeof validate === "function" ? (await validate(...args)) as ManualUploadValidationResult | null : null;
}

export function isBundledStaticSecretCredentialKind(kind: string): boolean {
  const value = optionalModules.capture?.isBundledStaticSecretCredentialKind;
  return typeof value === "function" ? value(kind) === true : kind === "secret_bundle" || kind === "username_password";
}

export function isFullyBundledStaticSecretCredentialKind(kind: string): boolean {
  const value = optionalModules.capture?.isFullyBundledStaticSecretCredentialKind;
  return typeof value === "function" ? value(kind) === true : kind === "secret_bundle";
}

export function connectorRetainsSurfaceProcess(connectorId: string): boolean {
  const policy = optionalModules.browserPolicy?.connectorRetainsSurfaceProcess;
  return typeof policy === "function" ? policy(connectorId) === true : false;
}

export async function notifyNtfy(args: Record<string, unknown>): Promise<void> {
  const notify = optionalModules.ntfy?.notify;
  if (typeof notify !== "function") {
    throw new Error("Ntfy notifications are unavailable until the connector runtime is installed.");
  }
  await notify(args);
}

export async function loadBrowserHelpers(): Promise<{
  readonly acquireBrowserForConnector?: (...args: readonly unknown[]) => Promise<unknown>;
  readonly acquireIsolatedBrowser?: (...args: readonly unknown[]) => Promise<unknown>;
  readonly resolveWsUrlForExactPage?: (...args: readonly unknown[]) => string;
}> {
  const acquireBrowserForConnector = optionalModules.browserLaunch?.acquireBrowserForConnector as
    | ((...args: readonly unknown[]) => Promise<unknown>)
    | undefined;
  const acquireIsolatedBrowser = optionalModules.browserLaunch?.acquireIsolatedBrowser as
    | ((...args: readonly unknown[]) => Promise<unknown>)
    | undefined;
  const resolveWsUrlForExactPage = optionalModules.browserHandoff?.resolveWsUrlForExactPage as
    | ((...args: readonly unknown[]) => string)
    | undefined;
  return {
    ...(acquireBrowserForConnector ? { acquireBrowserForConnector } : {}),
    ...(acquireIsolatedBrowser ? { acquireIsolatedBrowser } : {}),
    ...(resolveWsUrlForExactPage ? { resolveWsUrlForExactPage } : {}),
  };
}
