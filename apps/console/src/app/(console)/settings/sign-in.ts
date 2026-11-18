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

// The setup steps of Tailscale's sign-in, in the order the host returns them
// while the computer is signed out. The browser step has its own card; the
// others are one card with one button.
const SIGN_IN_CHAIN = new Set([
  "tailscale-setup",
  "tailscale-account",
  "tailscale-tailnet",
  "tailscale-login",
  "tailscale-node",
]);

/** True while the setup waits at a machine or owner step of the Tailscale sign-in. */
export function isSignInChain(view: SetupView): boolean {
  const action = view.nextAction;
  return view.state === "authorization-required" && !!action && SIGN_IN_CHAIN.has(action.id);
}

/** The fields the sign-in card asks for. The node step needs no typing. */
export function chainAsksFields(action: SetupAction): boolean {
  return action.id !== "tailscale-node";
}

/** The first https address in a help text, without the closing full stop. */
export function linkInHelp(help: string | undefined): string | null {
  const found = help?.match(/https:\/\/[^\s]+/)?.[0]?.replace(/[.,;)]+$/, "");
  return found && safeSignInUrl(found) ? found : null;
}

/** The computer the host observed, for the one option the node step offers. */
export function observedComputer(action: SetupAction): { host: string; value: string; label: string } | null {
  const options = action.step?.options;
  if (action.id !== "tailscale-node" || options?.length !== 1) return null;
  const [only] = options;
  return { host: only!.label.replace(/\s*\(.*\)\s*$/, ""), value: only!.value, label: only!.label };
}

/** Does the observed computer belong to the email the owner typed? */
export function computerMatchesEmail(label: string, email: string): boolean {
  const typed = email.trim().toLowerCase();
  return typed !== "" && label.toLowerCase().endsWith(`(${typed})`);
}

const ADMIN_COPY: Record<string, string> = {
  "tailscale-magicdns": "Turn on MagicDNS for your tailnet.",
  "tailscale-https": "Turn on HTTPS certificates for your tailnet.",
};

/** An administrator step the owner finishes in the Tailscale admin pages. */
export function adminStepCopy(view: SetupView): { line: string; href: string } | null {
  const action = view.nextAction;
  const line = action ? ADMIN_COPY[action.id] : undefined;
  const href = action?.href && safeSignInUrl(action.href);
  return action?.kind === "open-url" && !action.step?.browser && line && href ? { line, href: href.href } : null;
}

/** An account token or another typed value an account service asks for. */
export function isInputStep(view: SetupView): boolean {
  const action = view.nextAction;
  return (
    view.state === "authorization-required" &&
    !!action &&
    !SIGN_IN_CHAIN.has(action.id) &&
    (action.kind === "provide-secret" || action.kind === "provide-value")
  );
}
