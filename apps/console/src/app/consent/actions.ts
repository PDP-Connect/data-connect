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
 * Both actions return a serializable result rather than calling `redirect()`
 * themselves: success carries the external client URL, and failure carries
 * owner-facing copy for the page to show.
 */

import { computeHostedMcpDecisionDigest } from "pdpp-reference-implementation/hosted-mcp-decision-digest";
import { getAsInternalUrl, withOwnerSessionCookie } from "@/app/(console)/lib/owner-token.ts";
import { verifyDashboardSession } from "@/app/(console)/lib/verify-session.ts";
import type { ConsentActionResult, ConsentDecision } from "@/components/consent-screen/consent-screen-model.ts";

interface ChallengeError {
  readonly error?: string;
  readonly error_description?: string;
}

const OAUTH_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  access_denied: "This request was declined. Nothing was shared.",
  expired_token: "This request is no longer available. Nothing was shared.",
  invalid_client: "This app could not be verified. Nothing was shared.",
  invalid_grant: "This request is no longer available. Nothing was shared.",
  invalid_request: "This request is no longer valid. Nothing was shared.",
  invalid_scope: "The requested data is no longer available. Nothing was shared.",
  not_found: "This request is no longer available. Nothing was shared.",
  server_error: "This request could not be completed. Nothing was shared.",
  temporarily_unavailable: "This service is temporarily unavailable. Nothing was shared.",
  unauthorized_client: "This app is not allowed to request this data. Nothing was shared.",
  unsupported_response_type: "This app cannot request access in this way. Nothing was shared.",
};

const GENERIC_FAILURE_MESSAGE = "This request could not be completed. Nothing was shared.";

/**
 * The AS writes its owner-facing reasons as one short sentence ("Choose an end
 * date in the future."), while internal failures carry terse or technical text
 * (exception messages, stacks, identifiers, URLs). Only the first kind is shown.
 */
function isOwnerSentence(description: string): boolean {
  return (
    description.length <= 240 &&
    /^[A-Z][^\n]*[.?!]$/u.test(description) &&
    !/^(?:Error|[A-Za-z]+Error):/u.test(description) &&
    !/[a-z]+:\/\/|www\.|[\w-]+\.[a-z]{2,}\//iu.test(description) &&
    !/\b\w+_\w+\b|[{}<>`\\]/u.test(description)
  );
}

function safeFailureMessage(detail: ChallengeError | null): string {
  const description = typeof detail?.error_description === "string" ? detail.error_description.trim() : "";
  if (isOwnerSentence(description)) return description;
  const code = typeof detail?.error === "string" ? detail.error : undefined;
  const mappedCode = code && Object.hasOwn(OAUTH_ERROR_MESSAGES, code) ? OAUTH_ERROR_MESSAGES[code] : undefined;
  return mappedCode ?? GENERIC_FAILURE_MESSAGE;
}

/**
 * Posts to the challenge API and returns either the AS redirect or safe failure copy.
 *
 * A non-2xx may carry the AS's reason for refusing the decision. A reason
 * written as an owner-facing sentence is shown as is; otherwise known OAuth
 * codes map to plain copy, and anything else gets a generic sentence.
 *
 * This server-to-server JSON request carries the owner session, but no
 * `_csrf` token. The AS intentionally exempts application/json from its CSRF
 * token-pair check; with owner auth enabled, non-JSON browser submissions
 * still require a valid cookie/form token pair. The JSON exemption relies on
 * browsers requiring permission through CORS preflight for cross-origin JSON.
 */
async function postChallenge(
  challenge: string,
  action: "accept" | "reject",
  body: unknown
): Promise<ConsentActionResult> {
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
    return { ok: false, message: safeFailureMessage(detail) };
  }

  const { redirect_url } = (await response.json()) as { redirect_url?: string };
  if (!redirect_url) {
    return { ok: false, message: GENERIC_FAILURE_MESSAGE };
  }
  return { ok: true, redirectUrl: redirect_url };
}

export async function acceptConsentChallenge(
  challenge: string,
  clientId: string,
  decision: ConsentDecision
): Promise<ConsentActionResult> {
  // The digest covers exactly what the screen showed the owner: the client,
  // the access mode, and every chosen stream grouped under its source. Sorted
  // by the digest function itself, so the console never has to match the
  // server's ordering by hand.
  const decisionDigest = computeHostedMcpDecisionDigest({
    accessMode: decision.accessMode,
    clientId,
    grantExpiry: decision.grantExpiry,
    sources: decision.sources.map((source) => ({
      sourceKey: source.sourceId,
      streams: source.streamNames.map((streamName, index) => {
        const streamId = source.streamIds[index] ?? `${source.sourceId}:${streamName}`;
        return {
          fields: decision.streamFields[streamId] ?? null,
          name: streamName,
          timeRange: decision.streamRanges[streamId] ?? null,
        };
      }),
    })),
  });

  return postChallenge(challenge, "accept", {
    access_mode: decision.accessMode,
    decision_digest: decisionDigest,
    grant_expiry: decision.grantExpiry,
    review_digest: decision.reviewDigest,
    source_id: decision.sources.map((source) => source.sourceId),
    stream: decision.sources.flatMap((source) => source.streamIds),
    // Per-stream field and DATA-range narrowing. These are included in
    // `decision_digest` above and then independently declaration-checked by
    // the AS before issuance.
    stream_fields: decision.streamFields,
    stream_range: decision.streamRanges,
  });
}

export async function rejectConsentChallenge(challenge: string): Promise<ConsentActionResult> {
  return postChallenge(challenge, "reject", {});
}
