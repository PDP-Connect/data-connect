// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/consent` — where the owner decides what an app may read.
 *
 * The authorization server pauses the authorize request, parks it under an
 * opaque challenge id, and redirects here; this page loads the challenge's
 * render model, presents it, and posts the decision back. The AS keeps the
 * protocol — every validation, the grant creation, and the audit trail stay
 * on its side of the wire. This is the Ory-Hydra login-and-consent-app shape:
 * the UI is a separate application that the authorization server delegates to
 * and never trusts.
 *
 * Unauthenticated visitors go to owner login and return to THIS challenge:
 * `verifyDashboardSession` is given the full path, so the round trip lands
 * back on the same decision rather than the dashboard.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAsInternalUrl, withOwnerSessionCookie } from "@/app/(console)/lib/owner-token.ts";
import { verifyDashboardSession } from "@/app/(console)/lib/verify-session.ts";
import { loadConnectorBrandIndex } from "@/app/(console)/lib/connector-brand-index.ts";
import { ConsentScreen } from "@/components/consent-screen/consent-screen-client.tsx";
import type { ConsentDecision, ConsentScreenModel } from "@/components/consent-screen/consent-screen-model.ts";
import { acceptConsentChallenge, rejectConsentChallenge } from "./actions.ts";

// A consent decision is per-request and carries the requesting client's
// identity; it must never be indexed, cached, or followed.
export const metadata: Metadata = {
  robots: { follow: false, index: false, nocache: true },
};

// The model reflects the owner's connections at the moment they look, and a
// challenge is single-use. Nothing here may come from a cache.
export const dynamic = "force-dynamic";

async function loadChallenge(challenge: string): Promise<ConsentScreenModel | null> {
  const response = await fetch(
    `${getAsInternalUrl()}/oauth/authorize/consent-challenges/${encodeURIComponent(challenge)}`,
    {
      ...(await withOwnerSessionCookie({ headers: { accept: "application/json" } })),
      cache: "no-store",
    }
  );
  // Unknown, expired, and already-consumed are one answer from the AS, and
  // one answer here: this decision is no longer available to make.
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Consent challenge fetch failed (${response.status})`);
  }
  return (await response.json()) as ConsentScreenModel;
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const challenge = typeof params.challenge === "string" ? params.challenge : "";

  // Authoritative session check BEFORE the challenge is read, with a returnTo
  // that preserves the challenge across the login round trip.
  await verifyDashboardSession(challenge ? `/consent?challenge=${encodeURIComponent(challenge)}` : "/consent");

  if (!challenge) {
    notFound();
  }
  const [model, connectorIndex] = await Promise.all([loadChallenge(challenge), loadConnectorBrandIndex()]);
  if (!model) {
    notFound();
  }

  // Bound here so the challenge id and client identity travel with the action
  // itself and are never re-read from a form field the browser could alter.
  const clientId = model.client.id;
  async function acceptAction(decision: ConsentDecision): Promise<string> {
    "use server";
    return acceptConsentChallenge(challenge, clientId, decision);
  }
  async function rejectAction(): Promise<string> {
    "use server";
    return rejectConsentChallenge(challenge);
  }

  return <ConsentScreen acceptAction={acceptAction} connectorIndex={connectorIndex} model={model} rejectAction={rejectAction} />;
}
