// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Small fixtures with the shapes the real Gozar 0.5.0 host returns, built by hand
// from its adapters so a test fails for the reason the packaged app failed.
// Addresses use example.com and example.test only.

const trialDisclosureText =
  "Start a public HTTPS trial through the relay for the requested lifetime. " +
  "This allows outbound SSH on TCP port 22 and first-use trust in the session's private known-hosts file. " +
  "The relay terminates TLS and can read payloads.";

/**
 * The temporary-address setup action, as the host projects it.
 * Source: @tnunamak/gozar adapters/providers/localhost-run/ssh-setup.mjs:25-37 (`start`, id `trial-consent`):
 * kind `instructions`, an owner step with host verification and purpose `authorize`.
 * The text ends "Start the route through the Gozar route approval to open the connection."
 */
export const trialConsentAction = {
  id: "trial-consent",
  kind: "instructions",
  label: "Review the public HTTPS trial",
  digest: "9102587c43e2623a09590d64789ab205ebb593dd33a5b5676c069767883be6e4",
  instructions:
    "Allow this computer to connect to relay.example.com on outbound TCP port 22 for the approved trial lifetime. " +
    "The relay terminates HTTPS and can read application payloads. No provider account is needed. " +
    "Start the route through the Gozar route approval to open the connection.",
  disclosure: { revision: "disc-60cfdc367ce9", text: trialDisclosureText, links: [] },
  step: {
    actor: "owner",
    verification: "host",
    purpose: "authorize",
    permission: { id: "trial-consent", label: "Review the public HTTPS trial" },
  },
  consent: {
    consentFactsDigest: "consent-v1:54785bbef6f0ce123fe5f0a1b4e0dff20e8648e761107ee2310ca7d951972700",
    facts: [
      {
        id: "payload-readers",
        group: "privacy",
        label: "Payload readers",
        known: true,
        value: "The relay can read the traffic.",
        reason: null,
        source: "https://relay.example.com/",
        asOf: null,
        affectsConsent: true,
      },
    ],
    // The host nests the action itself under `action` (see the walk: keys Action, Digest, Kind, Revision).
    disclosures: {
      action: {
        id: "trial-consent",
        kind: "instructions",
        label: "Review the public HTTPS trial",
        digest: "9102587c43e2623a09590d64789ab205ebb593dd33a5b5676c069767883be6e4",
        disclosure: { revision: "disc-60cfdc367ce9", text: trialDisclosureText, links: [] },
        step: { actor: "owner", verification: "host", purpose: "authorize", permission: { id: "trial-consent", label: "Review the public HTTPS trial" } },
      },
    },
    scope: {
      kind: "setup",
      actionId: "trial-consent",
      actionDigest: "9102587c43e2623a09590d64789ab205ebb593dd33a5b5676c069767883be6e4",
      disclosureRevision: "disc-60cfdc367ce9",
      providerId: "localhost-run",
    },
  },
};

/**
 * What the host throws when a state folder is group-writable.
 * Source: @tnunamak/gozar packages/gozar-node/error-normalizer.mjs:27-35 (`stateAction`, mapping
 * `unsafe_state_path` to `setup_required`), read back through the real host in
 * reference-implementation/test/reachability-state-paths.test.ts. It has no `cause`.
 */
export const unsafeStateFolderError = Object.assign(new Error("The state folder can be written by others"), {
  code: "setup_required",
  nextAction: {
    id: "fix-state-permissions",
    kind: "instructions",
    label: "Fix the state directory permissions",
    digest: "sha256:gozar-fix-state-permissions",
    instructions: "Make the invoking user own the Gozar state directory, with no group or world write.",
    disclosure: { revision: "gozar-local-1", text: "Gozar changes nothing; you fix the directory yourself.", links: [] },
  },
});

/**
 * Tailscale's catalog prerequisites as the host reports them.
 * Source: @tnunamak/gozar packages/gozar-node/embedding-state.mjs:16-27 (`prerequisitesFor`): `present` when
 * the tool is detected, `missing` when it is not, `unknown` when the probe could not tell. The version is
 * always `{ known: false, reason: "not-observed" }`, so a signed-out and a signed-in daemon look the same.
 */
const tailscalePrerequisite = (state: "present" | "missing" | "unknown") => ({
  id: "local-setup",
  label: "Local prerequisites",
  state,
  observedAt: "2026-01-01T00:00:00.000Z",
  version: { known: false, reason: "not-observed" },
  remedy: null,
});
export const tailscaleFacts = {
  /** No Tailscale tool, or the daemon cannot be asked. */
  notRunning: [tailscalePrerequisite("unknown")],
  notInstalled: [tailscalePrerequisite("missing")],
  /** The tool is there and the daemon answers; whether anyone is signed in is not in the catalog. */
  signedOut: [tailscalePrerequisite("present")],
  /** Signed in looks the same in the catalog; the host's services list shows the setup was committed. */
  signedIn: [tailscalePrerequisite("present")],
};

/**
 * A route after its tunnel process was killed with no stop from the owner: the host reports it released,
 * the route inactive and the cleanup confirmed. The host's /state adds `stopRequested: false` because no
 * settled stop operation names its handle (reference-implementation owner-reachability.ts `ownerStopped`).
 */
export const diedRoute = {
  state: "released",
  routeState: "inactive",
  cleanup: { state: "confirmed" },
  verification: { status: "unverified", vantage: "public", observedAt: "2026-01-01T00:00:00.000Z" },
  handle: { kind: "session" },
  stopRequested: false,
};

/** Closed-schema route values, with example-only evidence and prose. */
export const typedRouteDisclosures = {
  ownership: "gozar-owned",
  reach: "internet",
  transport: "https",
  traffic: {
    providerCanReadPayload: true,
    tlsTermination: "provider",
    readers: ["route-service"],
    metadataVisibleTo: ["route-service", "connection-operator"],
    evidenceRef: "https://example.test/route-evidence",
  },
  address: { stability: "stable", scope: "a fixed public address" },
  cost: { kind: "free", summary: "There is no charge." },
  lifetimes: ["session", "attached"],
  supervision: "host-supervised",
  protocols: { sse: true, streamableHttp: true, oauthDcr: false },
  disclosure: { text: "This route connects to this computer.", links: [], revision: "example-v1" },
};
