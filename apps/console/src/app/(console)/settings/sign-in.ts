// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The human sign-in step of an account service (Tailscale, Cloudflare, ngrok)
// as the Remote access card shows it. Pure: it reads a setup view and says
// which words and which button the owner gets. No raw state name leaves here.
import type { projectSetupOperation } from "pdpp-reference-implementation/reachability-projection";

type SetupView = ReturnType<typeof projectSetupOperation>;
type SetupAction = NonNullable<SetupView["nextAction"]>;

export type SignInStage = "sign-in" | "denied" | "expired";

/**
 * "sign-in": the service waits for the owner in a browser (the host offers an
 * open-url step with a browser window). "denied" and "expired": the sign-in
 * ended without success. Anything else is not a sign-in step.
 */
export function signInStage(view: SetupView): SignInStage | null {
  if (view.state === "denied" || view.state === "expired") return view.state;
  const action = view.nextAction;
  if ((view.state === "pending" || view.state === "authorization-required") && action?.kind === "open-url" && action.step?.browser) {
    return "sign-in";
  }
  return null;
}

export type SignInCopy = { line: string; button: string | null };

export function signInCopy(stage: SignInStage, service: string, waiting: boolean): SignInCopy {
  if (stage === "denied") return { line: `${service} sign-in was cancelled.`, button: "Try again" };
  if (stage === "expired") return { line: `${service} sign-in took too long.`, button: "Try again" };
  return waiting
    ? { line: "Waiting for you to finish signing in…", button: null }
    : { line: `Sign in to ${service} to finish.`, button: `Sign in to ${service}` };
}

/** The approval the action's own consent data carries. Null when that data is incomplete. */
export function approvalFor(action: SetupAction) {
  const consent = action.consent;
  if (
    consent?.facts === undefined ||
    consent.disclosures == null ||
    consent.scope.kind !== "setup" ||
    consent.scope.actionId !== action.id ||
    consent.scope.actionDigest !== action.digest ||
    consent.scope.disclosureRevision !== action.disclosure.revision
  ) {
    return null;
  }
  return {
    kind: "setup" as const,
    digest: action.digest,
    disclosureRevision: action.disclosure.revision,
    consentFactsDigest: consent.consentFactsDigest,
  };
}

/** A sign-in link is only ever an https address with no embedded login. */
export function safeSignInUrl(href: string): URL | null {
  const url = URL.parse(href);
  return url && url.protocol === "https:" && !url.username && !url.password ? url : null;
}
