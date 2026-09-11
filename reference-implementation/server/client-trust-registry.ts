// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client trust resolution for the consent surface.
 *
 * Answers one question: what has this server actually verified about the
 * application asking for data, and what may it therefore render?
 *
 * `spec-core.md:675` requires a positive trust signal to be rendered
 * distinctly, and requires a client without one to be treated as unverified.
 * Both halves depend on each other. The consent page previously hardcoded
 * `isUnverified: true` on every path, so "Unverified app" was a badge no
 * client could ever escape — and a marker every client wears is not a
 * warning, it is wallpaper. Making verification reachable is what gives the
 * unverified state meaning for everyone who does not reach it.
 *
 * **The signal is domain control, and the copy says exactly that.** A client
 * whose `client_id` is an https URL serving a valid client-metadata document
 * (CIMD) has demonstrated control of that domain: `validateCimdUrl` requires
 * https with no userinfo, the document is fetched under SSRF guards, and
 * `validateCimdRedirectUris` pins every redirect target to the client_id
 * origin. Someone who cannot publish at `chatgpt.com` cannot complete that.
 *
 * That is a real, earned, automatic signal — and it is also a narrow one. It
 * proves who controls the domain. It proves nothing about whether the
 * application is honest, competent, or safe. So the surface says `Verified
 * domain: chatgpt.com` rather than "Verified app": the claim rendered is the
 * claim proven. Overclaiming here would be worse than the wallpaper badge it
 * replaces, because an owner would act on it.
 *
 * This path is automatic and applies to any conforming client. It is
 * deliberately not a hand-maintained list of blessed applications: a list
 * would demo a mechanism real clients never touch, and would leave every
 * unlisted client permanently unverifiable.
 *
 * **Operator overrides** (`spec-core.md:679-683`) remain available as the
 * first tier of the `spec-core.md:672` precedence, for deployments that want
 * to vouch for a client beyond what the protocol proves, or to allow-list a
 * logo host. They are an override layer, not the primary path.
 *
 * **Logos.** `spec-core.md:676` forbids rendering a client-supplied remote
 * logo unless the client is verified, or the asset has been proxied, cached,
 * and approved under local policy. Both conditions are enforced here rather
 * than either: the client must be domain-verified, AND the logo must be
 * https-served from the client_id's own domain or an operator-allow-listed
 * host, AND it is fetched server-side and cached for local re-serving. The
 * consent page never emits the client's URL, so the client cannot hotlink,
 * cannot see the owner's browser, and cannot swap the image after approval.
 * Anything failing those conditions renders the monogram.
 */

/** A logo the server has approved and cached locally. Never a client URL. */
export interface ClientTrustLogo {
  /** Accessible text for the image. */
  readonly alt: string;
  /** Cache key the server re-serves the stored bytes under. */
  readonly cacheKey: string;
  /** The upstream URL the bytes were fetched from, retained for audit only. */
  readonly sourceUri: string;
}

/** An optional operator trust decision about one exact `client_id`. */
export interface ClientTrustEntry {
  readonly client_id: string;
  /** Display name the operator vouches for; overrides the self-asserted name. */
  readonly client_name?: string;
  /** Extra hosts whose logo assets this client may use, beyond its own domain. */
  readonly logo_hosts?: readonly string[];
}

/** How this server established what it is willing to say about the client. */
export type ClientTrustBasis =
  /** No verification: nothing beyond what the client says about itself. */
  | "none"
  /** The client published a valid metadata document at its own https domain. */
  | "domain_verified"
  /** The operator vouched for this client explicitly. */
  | "operator_registered";

/** The resolved trust decision the consent surface renders. */
export interface ResolvedClientTrust {
  readonly basis: ClientTrustBasis;
  /** The domain proven to be under the client's control, or null. */
  readonly verifiedDomain: string | null;
  /** True when this server verified something; false means self-reported only. */
  readonly isTrusted: boolean;
  /** Operator-vouched display name, when an override supplied one. */
  readonly operatorDisplayName: string | null;
}

interface OperatorTrustOptions {
  /** Hosts allowed to serve logos for any client, e.g. a shared CDN. */
  logoHosts?: readonly string[] | null;
  trustedClients?: readonly ClientTrustEntry[] | null;
}

/** Normalized operator configuration consulted during trust resolution. */
export interface OperatorTrustConfig {
  readonly logoHosts: readonly string[];
  readonly trustedClients: readonly ClientTrustEntry[];
}

/** The client facts trust resolution needs. Mirrors the registered-client shape. */
export interface TrustCandidateClient {
  readonly client_id?: string | null;
  readonly registration_mode?: string | null;
}

const CIMD_REGISTRATION_MODE = "client_id_metadata_document";

const UNTRUSTED: ResolvedClientTrust = Object.freeze({
  basis: "none",
  isTrusted: false,
  operatorDisplayName: null,
  verifiedDomain: null,
});

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHost(value: unknown): string {
  const trimmed = trimmedString(value).toLowerCase();
  if (!trimmed) {
    return "";
  }
  // Accept either a bare host (`oaistatic.com`), a leading-dot wildcard
  // (`.oaistatic.com`), or a full URL, so operator config does not have to
  // guess which form is wanted.
  const leadingDot = trimmed.startsWith(".");
  const bare = leadingDot ? trimmed.slice(1) : trimmed;
  let host: string;
  try {
    host = new URL(bare).hostname.replace(/^www\./, "");
  } catch {
    host = bare.replace(/^www\./, "");
  }
  return host && leadingDot ? `.${host}` : host;
}

/**
 * Match a logo host against one allow-list pattern.
 *
 * An exact host matches only itself: `oaistatic.com` does not cover
 * `persistent.oaistatic.com`. Subdomains are a separate decision because
 * whoever controls a domain can mint any subdomain under it, so covering them
 * silently would widen the operator's decision beyond what they wrote. An
 * operator who does want the whole tree writes `.oaistatic.com`, which reads
 * as the wildcard it is.
 */
function hostMatchesPattern(host: string, pattern: string): boolean {
  if (!(host && pattern)) {
    return false;
  }
  if (pattern.startsWith(".")) {
    const suffix = pattern.slice(1);
    return host === suffix || host.endsWith(pattern);
  }
  return host === pattern;
}

/**
 * Host label for the identity line — `chatgpt.com`, not `https://chatgpt.com/`.
 * Returns null when the value is not a URL.
 */
export function trustHostLabel(value: string | null | undefined): string | null {
  const candidate = trimmedString(value);
  if (!candidate) {
    return null;
  }
  try {
    return new URL(candidate).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * Normalize operator configuration. Entries without a usable `client_id` are
 * dropped: an entry that survived with a blank id would match a request whose
 * `client_id` was also blank, turning a config typo into a verified badge.
 */
export function resolveOperatorTrustConfig(opts: OperatorTrustOptions = {}): OperatorTrustConfig {
  const configured = Array.isArray(opts.trustedClients) ? opts.trustedClients : [];
  const seen = new Set<string>();
  const trustedClients: ClientTrustEntry[] = [];
  for (const entry of configured) {
    const clientId = trimmedString(entry?.client_id);
    if (!clientId || seen.has(clientId)) {
      continue;
    }
    seen.add(clientId);
    const name = trimmedString(entry?.client_name);
    const logoHosts = (Array.isArray(entry?.logo_hosts) ? entry.logo_hosts : [])
      .map(normalizeHost)
      .filter(Boolean);
    trustedClients.push(
      Object.freeze({
        client_id: clientId,
        ...(name ? { client_name: name } : {}),
        logo_hosts: Object.freeze(logoHosts),
      })
    );
  }
  const logoHosts = (Array.isArray(opts.logoHosts) ? opts.logoHosts : []).map(normalizeHost).filter(Boolean);
  return Object.freeze({
    logoHosts: Object.freeze([...new Set(logoHosts)]),
    trustedClients: Object.freeze(trustedClients),
  });
}

/** Empty operator configuration — the default for a deployment that sets none. */
export const EMPTY_OPERATOR_TRUST_CONFIG: OperatorTrustConfig = resolveOperatorTrustConfig({});

/**
 * Resolve what this server has verified about a client.
 *
 * A CIMD client is domain-verified automatically; no list, no operator action.
 * An operator override can vouch for a client that has not proven a domain,
 * and can supply a display name that outranks the self-asserted one
 * (`spec-core.md:672` puts local registration first in the precedence).
 */
export function resolveClientTrust(
  client: TrustCandidateClient | null | undefined,
  config: OperatorTrustConfig = EMPTY_OPERATOR_TRUST_CONFIG
): ResolvedClientTrust {
  const clientId = trimmedString(client?.client_id);
  if (!clientId) {
    return UNTRUSTED;
  }
  // Exact-match only. A client_id is a whole identity; matching on origin
  // would let any sibling path on a trusted host inherit the decision.
  const override = config.trustedClients.find((row) => row.client_id === clientId) ?? null;
  const operatorDisplayName = trimmedString(override?.client_name) || null;

  if (client?.registration_mode === CIMD_REGISTRATION_MODE) {
    const verifiedDomain = trustHostLabel(clientId);
    if (verifiedDomain) {
      return Object.freeze({
        basis: "domain_verified",
        isTrusted: true,
        operatorDisplayName,
        verifiedDomain,
      });
    }
  }

  if (override) {
    return Object.freeze({
      basis: "operator_registered",
      isTrusted: true,
      operatorDisplayName,
      verifiedDomain: null,
    });
  }

  return UNTRUSTED;
}

/**
 * Decide whether a client-declared `logo_uri` may be fetched and cached.
 *
 * Three conditions, all required (`spec-core.md:676`):
 *   1. the client is verified — an unverified client never gets an image;
 *   2. the URL is https — no cleartext fetch, no non-web schemes;
 *   3. a domain-verified client may use the HTTPS URI in the identity
 *      document it proved control of; an operator-registered client must use
 *      its own domain or an operator allow-list.
 *
 * A domain-verified identity document is the client's authenticated metadata,
 * so its HTTPS `logo_uri` is an identity claim the AS may fetch through its
 * guarded cache. The browser never sees the URI. An operator registration
 * does not prove a domain, so its third-party asset hosts remain an operator
 * decision.
 *
 * Returning true authorizes a server-side fetch whose bytes are cached and
 * re-served locally. The client's URL is never emitted to the owner's browser.
 */
export function isLogoFetchAllowed(
  logoUri: string | null | undefined,
  clientId: string | null | undefined,
  trust: ResolvedClientTrust,
  config: OperatorTrustConfig = EMPTY_OPERATOR_TRUST_CONFIG
): boolean {
  if (!trust.isTrusted) {
    return false;
  }
  const candidate = trimmedString(logoUri);
  if (!candidate) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") {
    return false;
  }
  const logoHost = url.hostname.replace(/^www\./, "").toLowerCase();
  if (trust.basis === "domain_verified") {
    return true;
  }
  const clientHost = trustHostLabel(clientId);
  if (clientHost && logoHost === clientHost) {
    return true;
  }
  const perClient =
    config.trustedClients.find((row) => row.client_id === trimmedString(clientId))?.logo_hosts ?? [];
  return [...config.logoHosts, ...perClient].some((pattern) => hostMatchesPattern(logoHost, pattern));
}
