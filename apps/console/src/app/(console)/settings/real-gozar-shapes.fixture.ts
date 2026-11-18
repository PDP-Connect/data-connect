// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Small fixtures with the shapes the real Gozar 0.5.0 host returns, built by hand
// from its adapters so a test fails for the reason the packaged app failed.
// Addresses use example.com and example.test only.

const trialDisclosureText =
  "Start a public HTTPS trial through the relay for the requested lifetime (15 minutes by default). " +
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
  disclosure: { revision: "disc-e68dce2053c0", text: trialDisclosureText, links: [] },
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
        disclosure: { revision: "disc-e68dce2053c0", text: trialDisclosureText, links: [] },
        step: { actor: "owner", verification: "host", purpose: "authorize", permission: { id: "trial-consent", label: "Review the public HTTPS trial" } },
      },
    },
    scope: {
      kind: "setup",
      actionId: "trial-consent",
      actionDigest: "9102587c43e2623a09590d64789ab205ebb593dd33a5b5676c069767883be6e4",
      disclosureRevision: "disc-e68dce2053c0",
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
