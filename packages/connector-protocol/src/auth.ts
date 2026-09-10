// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Auth strategies for connectors.
 *
 * The runtime resolves `config.auth` into a `credentials` object that is
 * passed to collect(). Today we have one strategy (env-with-prompt-fallback).
 * Future strategies — OAuth token, refresh flows, shared provider (Login
 * with Google), platform-specific device flows — slot in here without
 * changing the runtime or the connector-facing shape.
 *
 * A strategy is a function:
 *     (config, runtime) => Promise<Record<string, string>>
 *
 * where `runtime` exposes { sendInteraction, connectorName }. The returned
 * object is whatever shape the connector expects — for env-based creds,
 * it's the env-var-name → value map. For OAuth it might be
 * { access_token, refresh_token, expires_at, ... }.
 */

import type { InteractionRequest, InteractionResponse } from "./connector-runtime-protocol.ts";

// ─── Public types ───────────────────────────────────────────────────────

/** Context the runtime hands to each auth strategy. */
export interface AuthStrategyContext {
  /**
   * Treat a missing credential as a SUPPORTED state rather than something to
   * ask the owner about. Session-first browser connectors authenticate through
   * the owner's browser profile; a stored username/password is an optional
   * auto-login shortcut, not the authenticator.
   *
   * When set, a strategy MUST resolve with whatever it has and MUST NOT call
   * `sendInteraction` to collect the remainder. Optional, and absent means
   * `false`, so every existing caller and strategy keeps today's
   * prompt-then-fail-closed behavior unchanged.
   */
  authOptional?: boolean;
  connectorName: string;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

/** A resolved credential bundle, keyed by the connector-declared primary name. */
export type Credentials = Record<string, string>;

/** Env-var strategy: one or more required names, each optionally with aliases. */
export interface EnvAuthConfig {
  kind: "env";
  required: ReadonlyArray<string | readonly string[]>;
}

/**
 * The union grows as strategies register themselves. For now, just env.
 * Future shapes: `{ kind: 'oauth', ... }`, `{ kind: 'shared_provider', ... }`.
 */
export type AuthConfig = EnvAuthConfig;

export type AuthStrategy<C extends AuthConfig = AuthConfig> = (
  config: C,
  runtime: AuthStrategyContext
) => Promise<Credentials>;

// ─── Strategy registry ──────────────────────────────────────────────────

const strategies = new Map<string, AuthStrategy>();

export function registerAuthStrategy<C extends AuthConfig>(kind: C["kind"], resolver: AuthStrategy<C>): void {
  // Cast narrows from the specific C to the general registry shape. Safe
  // because resolveAuth dispatches by kind before invoking the resolver.
  strategies.set(kind, resolver as AuthStrategy);
}

export function hasAuthStrategy(kind: string): boolean {
  return strategies.has(kind);
}

export function resolveAuth(config: AuthConfig | undefined, runtime: AuthStrategyContext): Promise<Credentials> {
  if (!config) {
    return Promise.resolve({});
  }
  const resolver = strategies.get(config.kind);
  if (!resolver) {
    return Promise.reject(new Error(`auth_strategy_unknown: ${config.kind}`));
  }
  return resolver(config, runtime);
}

// ─── Sign-in pair resolution ───────────────────────────────────────────

/**
 * A connector's sign-in pair is BOTH-OR-NOTHING, and an absent pair is
 * reported by naming the credential rather than by blaming the provider.
 *
 * The owner harm this prevents is a misdiagnosis. Handed a username with no
 * password, a connector would type the half it had into a real provider form,
 * submit, and then read the resulting page as the provider misbehaving —
 * telling the owner the sign-in form "did not render". So the owner went and
 * debugged the provider, while the true cause was a credential he had never
 * saved and was never told to save.
 *
 * `missing` names the absent fields and `reason` is safe to show: it contains
 * field NAMES only, never a credential value.
 */

/** A resolved, complete credential pair for one connection's sign-in. */
export interface ResolvedLoginCredentials {
  readonly kind: "resolved";
  readonly password: string;
  readonly username: string;
}

/** No usable credential for this connection. */
export interface AbsentLoginCredentials {
  readonly kind: "absent";
  /** The credential field names that were absent or blank. */
  readonly missing: readonly string[];
  /**
   * Owner-facing reason. Names the CREDENTIAL, never the page. Safe to
   * surface: it contains only field names, never credential values.
   */
  readonly reason: string;
}

export type LoginCredentialsResolution = AbsentLoginCredentials | ResolvedLoginCredentials;

/**
 * Field names, as they appear in the runtime-resolved `credentials` object,
 * that carry one connector's sign-in pair.
 */
export interface LoginCredentialFields {
  /** Credential field name(s) holding the password. First non-empty wins. */
  readonly password: readonly string[];
  /** Credential field name(s) holding the username/email. First non-empty wins. */
  readonly username: readonly string[];
}

function firstNonEmpty(
  credentials: Readonly<Record<string, string | undefined>>,
  names: readonly string[]
): string | undefined {
  return names
    .map((name) => credentials[name])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

/**
 * Resolve one connection's sign-in pair from the runtime-supplied credentials.
 *
 * A pair is both-or-nothing. A username with no password is reported absent
 * with the password named as missing, never submitted as half a login.
 */
export function resolveLoginCredentials(
  credentials: Readonly<Record<string, string | undefined>> | undefined,
  fields: LoginCredentialFields,
  connectorName: string
): LoginCredentialsResolution {
  const source = credentials ?? {};
  const username = firstNonEmpty(source, fields.username);
  const password = firstNonEmpty(source, fields.password);
  if (username && password) {
    return { kind: "resolved", password, username };
  }
  const missing: string[] = [];
  if (!username) {
    missing.push(fields.username[0] ?? "username");
  }
  if (!password) {
    missing.push(fields.password[0] ?? "password");
  }
  return {
    kind: "absent",
    missing,
    reason: noStoredCredentialReason(connectorName, missing),
  };
}

export function noStoredCredentialReason(connectorName: string, missing: readonly string[]): string {
  const fieldList = missing.length > 0 ? missing.join(", ") : "username, password";
  return (
    `no stored credential for this ${connectorName} connection (missing: ${fieldList}). ` +
    "Automated sign-in was not attempted. Save this connection's credentials to enable it."
  );
}

// ─── Built-in strategy: environment variables ──────────────────────────

const SECRET_NAME = /PASSWORD|SECRET|TOKEN/i;

interface CredentialProperty {
  description: string;
  format?: "password";
  type: "string";
}

/** Resolve one `required` entry (string or alias-array) against process.env. */
function resolveEnvEntry(entry: string | readonly string[]): { primary: string; value: string | undefined } | null {
  const aliases = Array.isArray(entry) ? entry : [entry];
  const [primary] = aliases;
  if (!primary) {
    return null;
  }
  for (const name of aliases) {
    const candidate = process.env[name];
    if (candidate) {
      return { primary, value: candidate };
    }
  }
  return { primary, value: undefined };
}

function buildCredentialSchema(
  missing: readonly string[],
  connectorName: string
): {
  type: "object";
  properties: Record<string, CredentialProperty>;
  required: readonly string[];
} {
  const properties: Record<string, CredentialProperty> = {};
  for (const name of missing) {
    const base: CredentialProperty = {
      description: `${name} for ${connectorName}`,
      type: "string",
    };
    properties[name] = SECRET_NAME.test(name) ? { ...base, format: "password" } : base;
  }
  return { properties, required: missing, type: "object" };
}

/**
 * Shape:
 *     auth: { kind: 'env', required: [
 *       'NOTION_API_TOKEN',
 *       ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN'], // alias list: first set wins
 *     ] }
 *
 * Each entry is either a single env-var name or an alias array (first set
 * wins; returned dict uses the primary name). If any entry is unresolved,
 * emit INTERACTION kind='credentials' for the primary names and block until
 * a response arrives — unless `runtime.authOptional` is set, in which case
 * the resolved subset is returned immediately and nothing is asked.
 *
 * Credentials whose name matches SECRET_NAME get `format: 'password'` in the
 * schema so UIs render a masked input.
 */
registerAuthStrategy<EnvAuthConfig>("env", async (config, runtime) => {
  const { required } = config;
  if (!Array.isArray(required) || required.length === 0) {
    throw new Error("auth_env_required_missing: auth.required must be a non-empty array");
  }

  const have: Credentials = {};
  const missing: string[] = [];
  for (const entry of required) {
    const resolved = resolveEnvEntry(entry);
    if (!resolved) {
      continue;
    }
    if (resolved.value === undefined) {
      missing.push(resolved.primary);
    } else {
      have[resolved.primary] = resolved.value;
    }
  }
  if (missing.length === 0) {
    return have;
  }
  // Session-first connector: the browser profile is the authenticator, so an
  // absent credential is a supported state, not a question for the owner.
  // Returning here — BEFORE the interaction, not after catching its failure —
  // is the whole point. A scheduled run has nobody to answer the prompt, and a
  // repair run would otherwise put a username/password form in front of an
  // owner whose account signs in through SSO, blocking the streamed-browser
  // journey the run had already prepared a surface for.
  //
  // The credential set is BOTH-OR-NOTHING, so an incomplete one resolves
  // EMPTY rather than partial. Returning `have` handed a username with no
  // password to the connector, which typed it into the provider's real form,
  // submitted, and then reported the resulting page as the PROVIDER
  // misbehaving — sending the owner to debug the provider over a credential
  // he had simply never saved. Resolving empty routes the connector down its
  // no-credential path (manual/session sign-in) instead, which is the honest
  // one. What `authOptional` suppresses is the QUESTION, never the fact.
  if (runtime.authOptional) {
    return {};
  }

  const resp = await runtime.sendInteraction({
    kind: "credentials",
    // Deliberately makes no persistence promise: values the owner submits to
    // an interaction are used for THIS RUN ONLY and are never written to
    // `.env.local`, durable config, or the spine event payload. Earlier copy
    // told the owner to "set in .env.local for persistence", which described
    // an operator-side deployment step as if it were the effect of answering
    // this prompt.
    message: `${runtime.connectorName} needs: ${missing.join(", ")}. Used for this run only.`,
    schema: buildCredentialSchema(missing, runtime.connectorName),
    timeout_seconds: 1800,
  });
  if (resp.status !== "success" || !resp.data) {
    throw new Error(`${runtime.connectorName}_credentials_missing`);
  }
  return { ...have, ...resp.data };
});
