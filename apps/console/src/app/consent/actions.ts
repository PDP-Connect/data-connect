// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use server";

/**
 * The consent page's two mutations, as Server Actions.
 *
 * These run on the console's server, not in the browser, which is what lets
 * the page compute the approval artifact digest honestly: `decision_digest`
 * binds the decision THIS SURFACE DISPLAYED, and the AS independently
 * recomputes it from what it resolved (AS-conformance #15). Computing it here
 * — in the same process that rendered the model, using the reference
 * implementation's own digest function rather than a second implementation —
 * keeps the two sides byte-identical by construction.
 *
 * Both actions return the client redirect URL rather than calling `redirect()`
 * themselves: the target is an external origin (the client's `redirect_uri`),
 * and the page navigates to it from the browser.
 */

import { computeHostedMcpDecisionDigest } from "pdpp-reference-implementation/hosted-mcp-decision-digest";
import { getAsInternalUrl, withOwnerSessionCookie } from "@/app/(console)/lib/owner-token.ts";
import { verifyDashboardSession } from "@/app/(console)/lib/verify-session.ts";
import type { ConsentDecision } from "@/components/consent-screen/consent-screen-model.ts";

interface ChallengeError {
  readonly error?: string;
  readonly error_description?: string;
}

/**
 * Posts to the challenge API and returns the redirect the AS issued.
 *
 * A non-2xx carries the AS's own owner-facing sentence (stale digest, empty
 * selection, bad expiry). Surfacing that text rather than a status code is
 * deliberate: the AS is the only party that knows why the approval was
 * refused, and the owner is the one who has to act on it.
 */
async function postChallenge(challenge: string, action: "accept" | "reject", body: unknown): Promise<string> {
  await verifyDashboardSession();
  const response = await fetch(
    `${getAsInternalUrl()}/oauth/authorize/consent-challenges/${encodeURIComponent(challenge)}/${action}`,
    {
      ...(await withOwnerSessionCookie({
        body: JSON.stringify(body),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      })),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as ChallengeError | null;
    throw new Error(
      detail?.error_description || `This request could not be completed (${response.status}). Nothing was shared.`
    );
  }

  const { redirect_url } = (await response.json()) as { redirect_url?: string };
  if (!redirect_url) {
    throw new Error("The server approved this request but did not say where to return. Nothing was shared.");
  }
  return redirect_url;
}

export async function acceptConsentChallenge(
  challenge: string,
  clientId: string,
  decision: ConsentDecision
): Promise<string> {
  // The digest covers exactly what the screen showed the owner: the client,
  // the access mode, and every chosen stream grouped under its source. Sorted
  // by the digest function itself, so the console never has to match the
  // server's ordering by hand.
  const decisionDigest = computeHostedMcpDecisionDigest({
    accessMode: decision.accessMode,
    clientId,
    sources: decision.sources.map((source) => ({
      sourceKey: source.sourceId,
      streamNames: [...source.streamNames],
    })),
  });

  return postChallenge(challenge, "accept", {
    access_mode: decision.accessMode,
    decision_digest: decisionDigest,
    grant_expiry: decision.grantExpiry,
    review_digest: decision.reviewDigest,
    source_id: decision.sources.map((source) => source.sourceId),
    stream: decision.sources.flatMap((source) => source.streamIds),
  });
}

export async function rejectConsentChallenge(challenge: string): Promise<string> {
  return postChallenge(challenge, "reject", {});
}
