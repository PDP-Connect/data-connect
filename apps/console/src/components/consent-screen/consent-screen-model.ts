// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The consent screen's data contract — the client-side mirror of the
 * authorization server's `HostedMcpConsentChallengeModel`
 * (reference-implementation/server/routes/as-consent-ui-helpers.ts).
 *
 * Declared here rather than imported from the reference implementation
 * because this is a "use client" component tree: importing a server module
 * would drag its Node-only dependencies into the browser bundle. The AS is
 * the source of truth for the SHAPE; the console's own contract test
 * (consent-screen.test.ts) pins the two together so a field the server
 * renames cannot silently read as `undefined` here.
 *
 * Everything in this model is a FACT the server resolved. None of it is copy:
 * the sentences the owner reads are written in `consent-screen-client.tsx`,
 * except where the server owns the statement because only the server knows
 * whether it is true (`retention`, `purpose.description`).
 */

export type ConsentTrustTier = "unverified" | "domain" | "verified";

/** Manifest-declared brand glyph, shaped for `ConnectorIcon`'s `icon` prop. */
export interface ConsentSourceIcon {
  readonly color?: string | null;
  readonly kind?: string | null;
  readonly svg?: string | null;
}

export interface ConsentStreamModel {
  /** Total schema fields this stream would expose. `0` means the manifest declared none. */
  readonly fieldsTotal: number;
  /** `${sourceId}:${name}` — the id the accept request sends back. */
  readonly id: string;
  readonly label: string;
  readonly name: string;
  /** Opaque server encoding; the console echoes it, never parses it. */
  readonly selectionValue: string;
  readonly selected: boolean;
  readonly sentence: string;
  /**
   * Human phrasing of the stream's own time field, present only when the
   * manifest declares `consent_time_field`. Absent suppresses the data-range
   * control entirely — the stream has no date axis to narrow.
   */
  readonly timePhrase?: string;
}

export interface ConsentSourceModel {
  readonly account: string;
  readonly icon?: ConsentSourceIcon | null;
  readonly id: string;
  readonly name: string;
  readonly selectionValue: string;
  readonly streams: readonly ConsentStreamModel[];
}

export interface ConsentScreenModel {
  readonly accessMode: { readonly supported: readonly string[]; readonly value: string };
  readonly challenge: string;
  readonly client: {
    /** The origin the client PROVED it controls, or null when it proved none. */
    readonly domain: string | null;
    /**
     * The raw `client_id`, needed to compute `decision_digest` over the client
     * identity this screen displayed. A public authorize parameter, not a
     * secret — but it is never rendered, only bound into the approval.
     */
    readonly id: string;
    readonly monogram: string;
    readonly name: string;
    readonly policyLinks: ReadonlyArray<{ readonly href: string; readonly label: string }>;
    /** Host the owner will be sent back to. A different fact from `domain`. */
    readonly returnTo: string | null;
    readonly trust: ConsentTrustTier;
  };
  readonly grantExpiry: {
    readonly defaultId: string;
    readonly options: ReadonlyArray<{ readonly days: number | null; readonly id: string; readonly label: string }>;
  };
  readonly purpose: { readonly code: string; readonly description: string };
  readonly retention: string;
  readonly reviewDigest: string;
  readonly sources: readonly ConsentSourceModel[];
}

/** One source's decision: the source, and which of its streams the owner chose. */
export interface ConsentSelectedSource {
  readonly sourceId: string;
  readonly streamIds: readonly string[];
  readonly streamNames: readonly string[];
}

/**
 * What the owner decided, as the page submits it.
 *
 * `reviewDigest` is echoed from the model unchanged so the server can
 * re-resolve it and fail closed if the owner's eligible connections changed
 * while this page was open.
 */
export interface ConsentDecision {
  readonly accessMode: string;
  /** A grant-expiry option id (`90d` / `1y` / `never`), or an ISO date the owner picked. */
  readonly grantExpiry: string;
  readonly reviewDigest: string;
  readonly sources: readonly ConsentSelectedSource[];
}
