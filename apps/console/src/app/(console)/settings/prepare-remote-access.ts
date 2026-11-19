// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// What happens when the Remote access card opens with the password set and
// nothing running: the same server calls the owner used to click through, run
// in the same order. Every safety check lives on the server and binds data (the
// draft revision, the action digest, the review id and the consent digest), so
// running them without clicks keeps each check. This module never starts a
// public route: it never calls apply or approve.
import type {
  projectAction,
  projectCandidate,
  projectConfiguration,
  projectDraft,
  projectInventory,
} from "pdpp-reference-implementation/reachability-projection";
import { ReachabilityFailure } from "./diagnostics.tsx";
import type { requestReachability } from "./reachability-actions.ts";
import { publicError } from "./reachability-errors.ts";
import type { ServiceEntry } from "./setup-services.ts";

type Request = typeof requestReachability;
export type Draft = ReturnType<typeof projectDraft>;
export type Inventory = ReturnType<typeof projectInventory>;
export type Candidate = ReturnType<typeof projectCandidate>;
export type Action = ReturnType<typeof projectAction>;
export type Review = { id: string; kind: "route"; candidate: Candidate };
type Configuration = ReturnType<typeof projectConfiguration>;

// ---------- which setup actions have effects ----------

/**
 * The library reports an action's effects only through the optional `effects`
 * field, and only the install actions carry it. An action with no `effects`
 * field does not say it has none, so it counts as having effects. Only an
 * action that declares an empty effect list, needs no owner step and no input
 * can run without asking.
 */
export function hasEffects(action: Action, hasInput = false): boolean {
  if (hasInput || action.step || action.artifact) return true;
  if (action.kind !== "gozar-runs") return true;
  const effects = action.effects;
  if (!effects) return true;
  return effects.writes.length > 0 || effects.networkOrigins.length > 0 || effects.requiresPrivilege || effects.restartRequired;
}

type InputField = Draft["configuration"]["inputRequirements"][number];

/** True when the draft already holds the value (or the secret) this input asks for. */
function inputGiven(configuration: Draft["configuration"], field: InputField): boolean {
  if (!field.secret) return field.id in configuration.values;
  const held = configuration.credentials[field.id];
  return held?.known === true && held.value === true;
}

/** The effects in the owner's words, from what the action declares. */
export function effectLines(action: Action): string[] {
  const lines: string[] = [];
  if (action.artifact) lines.push(`Installs software on this computer (${action.artifact.platform}).`);
  const effects = action.effects;
  if (effects) {
    for (const path of effects.writes) lines.push(`Changes ${path}.`);
    for (const origin of effects.networkOrigins) lines.push(`Connects to ${origin}.`);
    if (effects.requiresPrivilege) lines.push("Needs administrator permission.");
    if (effects.restartRequired) lines.push("Needs a restart to finish.");
  }
  if (action.disclosure.text) lines.push(action.disclosure.text);
  if (lines.length === 0) lines.push("This step can change this computer or your account.");
  return lines;
}

/**
 * An owner step that only asks the owner to authorize the route, such as the temporary
 * address's trial consent (gozar adapters/providers/localhost-run/ssh-setup.mjs:25-37).
 * The host cannot run an `instructions` step (service.ts runSetupOperation throws
 * setup_action_unavailable), and the route approval carries the consent. So it is shown
 * with Turn on and never approved on its own.
 */
export function isRouteConsentStep(action: Action): boolean {
  return action.kind === "instructions" && action.step?.actor === "owner" && action.step.purpose === "authorize";
}

// ---------- default way ----------

const usageOrder = ["session", "attached", "durable"] as const;
type Capabilities = Record<string, { known: boolean; value?: boolean | string }>;

/** The lifetime kind to use for a way: the first one it offers and this computer can run. */
export function pickUsage(provider: Inventory["providers"][number], capabilities: Capabilities): string | null {
  for (const kind of usageOrder) {
    const available = provider.availability[kind];
    if (!available || !(available.state === "available" || available.state === "action-required")) continue;
    if (kind === "durable" && capabilities["runtime.durable"]?.value === false) continue;
    return kind;
  }
  return null;
}

/** A temporary address that needs no account comes first; then anything that is not local-only. */
export function defaultProvider(inventory: Inventory, capabilities: Capabilities): Inventory["providers"][number] | undefined {
  const usable = inventory.providers.filter((item) => pickUsage(item, capabilities) !== null);
  return (
    usable.find((item) => item.providerId === "localhost-run" && pickUsage(item, capabilities) === "session") ??
    usable.find((item) => item.reach !== "lan" && pickUsage(item, capabilities) === "session") ??
    usable.find((item) => item.reach !== "lan") ??
    usable[0]
  );
}

// ---------- the chain ----------

export type Prepared =
  // `steps`: owner steps the route approval itself satisfies; the card shows their facts beside the review's.
  | { kind: "ready"; draft: Draft; review: Review; steps: Action[] }
  // A setup action with effects. It waits for Allow.
  | { kind: "allow"; draft: Draft; action: Action }
  // A step the owner does outside this page (sign in). The setup card shows it.
  | { kind: "sign-in"; draft: Draft; action: Action }
  // A setup the host already holds for this service is not finished.
  | { kind: "setup-pending"; draft: Draft };

// Codes that mean the review the owner saw is no longer the one the host holds.
export const staleReviewCodes = new Set([
  "consent_expired",
  "consent_changed",
  "consent_mismatch",
  "candidate_stale",
  "configuration_stale",
  "review_not_found",
]);
const restartCodes = new Set(["draft_not_found", "configuration_stale", "draft_scope_mismatch", "candidate_stale"]);
const codeOf = (failure: unknown) => (failure instanceof ReachabilityFailure ? failure.detail.code : null);

type Choice = { providerId: string; usage: string };

export const PREPARATION_REQUEST_TIMEOUT_MS = 15_000;
// A restart re-reads the host's state, so another preparer's committed draft is picked up. A few
// restarts cover a few preparers racing; the chain never retries without a bound.
export const MAX_PREPARATION_RESTARTS = 6;

/**
 * The preparation may no longer send a positive request: its screen went away,
 * a newer preparation replaced it, or the password is gone. Not a failure to
 * show; the caller drops it.
 */
export class PreparationStopped extends Error {
  constructor() {
    super("preparation_stopped");
  }
}

/**
 * Inventory, then the service's draft (reused by id), then each setup action
 * that has no effects, then commit, then review. It stops at the first human
 * step. Other preparers on the same profile share the host's one draft for the
 * service, so a restart code means the state moved, not that this draft is bad:
 * the chain re-reads the state, up to MAX_PREPARATION_RESTARTS times. A restart
 * discards a draft only when it is the service's uncommitted draft (or has failed
 * twice), because a draft another preparer committed or is reviewing is shared work.
 */
export async function prepareTurnOn(
  request: Request,
  choice: Choice,
  options: { restarts?: number; failedDrafts?: ReadonlySet<string>; mayRunActions?: () => boolean; isCurrent?: () => boolean; onPasswordMissing?: () => void } = {}
): Promise<Prepared> {
  // Checked before every positive request (draft, action, commit, review, discard).
  // Reads are never guarded: a stopped chain may finish the read it already sent.
  const proceed = () => {
    if (options.isCurrent?.() === false || options.mayRunActions?.() === false) throw new PreparationStopped();
  };
  const send = async <T>(path: string, body?: Record<string, unknown>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        request(path, body),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ReachabilityFailure(publicError("reachability_unavailable"))), PREPARATION_REQUEST_TIMEOUT_MS);
        }),
      ]);
      if (!result.ok) throw new ReachabilityFailure(result);
      return result.data as T;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const inventory = await send<Inventory>("/catalog");
  const provider = inventory.providers.find((item) => item.providerId === choice.providerId);
  if (!provider) throw new ReachabilityFailure(publicError("configuration_stale"));
  const state = await send<{ services?: ServiceEntry[]; passwordSet?: boolean }>("/state");
  // This read is newer than the caller's last poll. Without a password nothing positive runs.
  if (state.passwordSet === false) {
    if (options.isCurrent?.() !== false) options.onPasswordMissing?.();
    throw new PreparationStopped();
  }
  const entry = state.services?.find((item) => item.providerId === choice.providerId);
  let draft: Draft | null = null;
  let committed = false;
  try {
    if (entry?.draftId) {
      draft = await send<Draft>(
        `/drafts/${encodeURIComponent(entry.draftId)}?providerId=${encodeURIComponent(choice.providerId)}`
      );
      committed = entry.committed;
    }
  } catch (failure) {
    if (codeOf(failure) !== "draft_not_found") throw failure;
  }
  try {
    if (!draft) {
      proceed();
      // The host reuses a draft it already holds for this service.
      draft = await send<Draft>("/drafts", {
        providerId: choice.providerId,
        expectedRevision: provider.configuration.revision,
        usage: choice.usage,
      });
      committed = false;
    }
    if (!committed && entry?.setup) {
      // Nothing is committed while the service's own setup is still open.
      const setupPath = `/setup-operations/${encodeURIComponent(entry.setup.operationId)}`;
      const setup = await send<{ state: string }>(`${setupPath}?providerId=${encodeURIComponent(choice.providerId)}`);
      if (setup.state === "blocked") {
        // The library holds a setup it can no longer advance: the draft it was started on is gone
        // (a commit or a discard in an earlier run used it up). It is released when it holds nothing
        // to remove, and shown as pending when it still holds a resource.
        proceed();
        const ended = await send<{ state: string; resources?: { removal?: string }[] }>(`${setupPath}/cancel`, {
          providerId: choice.providerId,
        });
        const holding = (ended.resources ?? []).some((item) => item.removal === "required" || item.removal === "unconfirmed");
        if (ended.state !== "cancelled" || holding) return { kind: "setup-pending", draft };
      } else if (setup.state !== "complete" && setup.state !== "cancelled") {
        return { kind: "setup-pending", draft };
      }
    }
    if (!committed) {
      for (const action of draft.configuration.actions) {
        const field = draft.configuration.inputRequirements.find((item) => item.actionId === action.id);
        const needsInput = field !== undefined;
        // The caller posts the setup for a sign-in step, so it only gets one while this may still act.
        proceed();
        if (isRouteConsentStep(action)) continue;
        // An input the owner already gave stays in the draft's action list, and so does the
        // action that would forget it. Neither is a step of turning on; asking again would never end.
        if (action.kind === "clear-input" || (field && inputGiven(draft.configuration, field))) continue;
        if (action.step) return { kind: "sign-in", draft, action };
        if (hasEffects(action, needsInput)) return { kind: "allow", draft, action };
        draft = await runAction(send, draft, action);
      }
      proceed();
      await send<Configuration>(`/drafts/${encodeURIComponent(draft.draftId)}/commit`, {
        expectedRevision: draft.configuration.revision,
      });
    }
    proceed();
    const review = await send<Review>(`/drafts/${encodeURIComponent(draft.draftId)}/review`, { usage: choice.usage });
    return { kind: "ready", draft, review, steps: draft.configuration.actions.filter(isRouteConsentStep) };
  } catch (failure) {
    const code = codeOf(failure);
    const restarts = options.restarts ?? 0;
    if (restarts < MAX_PREPARATION_RESTARTS && code && restartCodes.has(code)) {
      proceed();
      const failedDrafts = new Set(options.failedDrafts);
      if (draft) {
        const repeated = failedDrafts.has(draft.draftId);
        failedDrafts.add(draft.draftId);
        await discardIfOnlyOurs(send, choice.providerId, draft.draftId, repeated, proceed);
      }
      return prepareTurnOn(request, choice, { ...options, restarts: restarts + 1, failedDrafts });
    }
    throw failure;
  }
}

/**
 * Drops a draft that failed with a restart code, so a restart does not resume it again. Without
 * this, the host hands back its stale uncommitted draft and the chain would fail the same way.
 * The host's current state decides: a draft that is gone, replaced or committed by another
 * preparer is left alone (committed work is reviewed, not thrown away) unless it already failed once.
 */
async function discardIfOnlyOurs(
  send: <T>(path: string, body?: Record<string, unknown>) => Promise<T>,
  providerId: string,
  draftId: string,
  repeated: boolean,
  proceed: () => void
): Promise<void> {
  const state = await send<{ services?: ServiceEntry[] }>("/state");
  const entry = state.services?.find((item) => item.providerId === providerId);
  if (entry?.draftId !== draftId || (entry.committed && !repeated)) return;
  proceed();
  try {
    await send(`/drafts/${encodeURIComponent(draftId)}/discard`, {});
  } catch (failure) {
    // Already gone is the state this wanted.
    if (codeOf(failure) !== "draft_not_found") throw failure;
  }
}

/** Runs one setup action with the approval its own consent data carries. */
export async function runAction(
  send: <T>(path: string, body?: Record<string, unknown>) => Promise<T>,
  draft: Draft,
  action: Action,
  input: { value?: string; secret?: string } = {}
): Promise<Draft> {
  const consent = action.consent;
  if (!consent) throw new ReachabilityFailure(publicError("consent_required"));
  const configuration = await send<Configuration>(
    `/drafts/${encodeURIComponent(draft.draftId)}/${action.kind === "clear-input" ? "clear" : "actions"}/${encodeURIComponent(action.id)}`,
    {
      expectedRevision: draft.configuration.revision,
      approval: {
        kind: "setup",
        digest: action.digest,
        disclosureRevision: action.disclosure.revision,
        consentFactsDigest: consent.consentFactsDigest,
      },
      ...input,
    }
  );
  return { ...draft, configuration };
}

// ---------- what the Turn on button shows ----------

/** The reading each short fact line gets, and so the icon it carries. */
export type FactKind = "access" | "traffic" | "deal";
export type FactLine = { kind: FactKind; text: string };

/** One short line per material fact, all read from the review being shown. */
export function disclosureLines(candidate: Candidate): string[] {
  return formatDisclosures(candidate).lines.map((line) => line.text);
}

const isDisclosureRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const oneOf = (...choices: string[]) => (value: unknown): value is string =>
  typeof value === "string" && choices.includes(value);
const listOf = (item: (value: unknown) => boolean) => (value: unknown): value is unknown[] =>
  Array.isArray(value) && value.every(item);

/**
 * Classify the route schema once. Consume fields only after their shape is checked and they are worded
 * or identified as metadata. The unclassified remainder is still available to the generic text walker.
 * Invalid known values open Details even if they happen to look like machine words.
 */
export function formatDisclosures(candidate: Candidate): { lines: FactLine[]; remaining: unknown; unread: boolean } {
  const consent = candidate.consent;
  const original = consent?.disclosures;
  const rest: Record<string, unknown> = isDisclosureRecord(original) ? { ...original } : {};
  let unread = original != null && !isDisclosureRecord(original);
  const lines: FactLine[] = [
    { kind: "access", text: "People who open the address must sign in with your password. Apps also need your permission." },
  ];

  function take<T>(parent: Record<string, unknown>, key: string, valid: (value: unknown) => value is T): T | undefined {
    if (!Object.hasOwn(parent, key)) return;
    const value = parent[key];
    if (valid(value)) {
      delete parent[key];
      return value;
    }
    unread = true;
    return undefined;
  }
  function section(key: string, classify: (section: Record<string, unknown>) => void) {
    if (!Object.hasOwn(rest, key)) return;
    const value = rest[key];
    if (!isDisclosureRecord(value)) {
      unread = true;
      return;
    }
    const fields = { ...value };
    classify(fields);
    if (Object.keys(fields).length === 0) delete rest[key];
    else rest[key] = fields;
  }
  function wordEnum(parent: Record<string, unknown>, key: string, words: Record<string, string>, kind: FactKind) {
    const value = take(parent, key, oneOf(...Object.keys(words)));
    if (value !== undefined && words[value]) lines.push({ kind, text: words[value] });
  }

  wordEnum(rest, "reach", {
    internet: "People can reach the sign-in page over the internet.",
    tailnet: "Only people on your private network can reach the sign-in page.",
    lan: "Only people on your local network can reach the sign-in page.",
    "this-device": "Only this device can reach the sign-in page.",
    unknown: "We can't tell who can reach the sign-in page.",
  }, "access");
  wordEnum(rest, "transport", {
    http: "This connection uses unencrypted HTTP. Traffic may be readable in transit.",
    tcp: "This connection uses TCP without transport encryption.",
    // Encrypted transports are the expected default and need no words.
    https: "",
    tls: "",
  }, "traffic");
  const service = candidate.display.label;
  let payloadReading = `We can't tell whether ${service} can read what passes through.`;
  section("traffic", (traffic) => {
    const reads = take(traffic, "providerCanReadPayload", (v): v is boolean | null => v === null || isBoolean(v));
    if (reads === true) payloadReading = `${service} can see what passes through.`;
    if (reads === false) payloadReading = `${service} can't read what passes through.`;
    wordEnum(traffic, "tlsTermination", {
      // Encryption that ends at your device is the expected default and needs no words.
      endpoint: "",
      provider: "The secure connection ends at the service, not at your device.",
      unknown: "We can't tell where the secure connection ends.",
    }, "traffic");
    const readers = take(traffic, "readers", listOf(isText));
    // Named here, above the button: Details sits below it unless something is unreadable.
    if (readers?.length) lines.push({ kind: "traffic", text: `These can read your traffic: ${readers.join(", ")}.` });
    const metadata = take(traffic, "metadataVisibleTo", listOf(isText));
    if (metadata?.length) lines.push({ kind: "traffic", text: `These can see when and how much you connect: ${metadata.join(", ")}.` });
    // Reference to supporting evidence, not a statement about the connection.
    take(traffic, "evidenceRef", (v): v is string | null => v === null || typeof v === "string");
  });
  lines.push({ kind: "traffic", text: payloadReading });

  let price = "We can't tell what this costs.";
  section("cost", (cost) => {
    const kind = take(cost, "kind", oneOf("free", "paid", "unknown"));
    if (kind === "free") price = "Free.";
    if (kind === "paid") {
      const amount = take(cost, "amount", isNumber);
      const currency = take(cost, "currency", isText);
      const period = take(cost, "period", isText);
      if (amount !== undefined && currency !== undefined && period !== undefined) {
        price = `Costs ${amount} ${currency} per ${period}.`;
      } else {
        price = "This costs money. The price is in Details.";
        unread = true;
      }
    } else if (["amount", "currency", "period"].some((key) => Object.hasOwn(cost, key))) {
      unread = true;
    }
    // Leave the cost summary to the walker: it can include terms not covered by the amount.
  });
  lines.push({ kind: "deal", text: price });
  section("address", (address) => {
    wordEnum(address, "stability", {
      stable: "The address stays the same.",
      ephemeral: "The address changes each time.",
      unknown: "We can't tell whether the address stays the same.",
    }, "deal");
    // Describes how the address is allocated; reach, stability and the actual address are shown separately.
    take(address, "scope", (v): v is string => typeof v === "string");
  });

  const usage = consent?.scope?.query.usage?.kind;
  lines.push({
    kind: "deal",
    text:
      usage === "session" ? "Turns off by itself. The time shows once it's on."
      : usage === "durable" ? "Stays on until you turn it off."
      : usage === "attached" ? "Stays on while DataConnect runs."
      : "We can't tell how long this lasts.",
  });
  // Supported modes are catalog metadata; the usage above is the one being approved.
  take(rest, "lifetimes", listOf(oneOf("session", "attached", "durable")));
  // Lifecycle implementation and ownership are not reach, privacy, or the approved usage.
  take(rest, "supervision", oneOf("controller", "provider-persistent", "host-supervised"));
  take(rest, "ownership", oneOf("gozar-owned", "external-owned"));
  // Capability flags describe app compatibility, not which route or usage is being approved.
  section("protocols", (protocols) => {
    for (const flag of ["sse", "streamableHttp", "oauthDcr"]) take(protocols, flag, isBoolean);
  });
  // Keep the adapter's explanatory disclosure text with any unclassified fields; Details retains the full value.
  section("disclosure", (disclosure) => {
    if (Object.hasOwn(disclosure, "text") && typeof disclosure.text !== "string") unread = true;
  });

  return { lines, remaining: isDisclosureRecord(original) ? rest : original, unread };
}

/** The facts whose value differs between two reviews, by label. */
export function changedFacts(before: Candidate, after: Candidate): string[] {
  const old = new Map(before.facts.map((fact) => [fact.id, fact]));
  const labels: string[] = [];
  for (const fact of after.facts) {
    const prior = old.get(fact.id);
    if (!prior || prior.known !== fact.known || prior.value !== fact.value) labels.push(fact.label);
  }
  for (const fact of before.facts) {
    if (!after.facts.some((item) => item.id === fact.id)) labels.push(fact.label);
  }
  return [...new Set(labels)];
}

export const reviewExpired = (review: Review, now: number): boolean => {
  const expiry = review.candidate.expiresAt ? Date.parse(review.candidate.expiresAt) : Number.NaN;
  return Number.isFinite(expiry) && expiry <= now;
};

// ---------- how a finished operation reads ----------

// Codes the host reports only when it refused before it did anything.
const beforeAnyEffect = new Set([
  "host_policy_denied",
  "artifact_integrity_failed",
  "requirements_unsatisfied",
  "consent_required",
  "consent_unknown",
  "consent_changed",
  "consent_expired",
  "consent_mismatch",
  "configuration_stale",
  "configuration_in_use",
  "unsupported",
  "provider_unavailable",
  "operation_conflict",
]);

/**
 * "did-not-turn-on" only when the host says it failed before any effect.
 * Anything else that failed may have left something live, so it needs the owner.
 */
export function operationOutcome(operation: {
  stage: string;
  failureCode?: string | null;
  handle?: unknown;
  recovery?: unknown;
}): "turning-on" | "done" | "did-not-turn-on" | "needs-action" {
  if (operation.stage === "applying") return "turning-on";
  if (operation.stage === "unknown-possibly-live" || operation.recovery) return "needs-action";
  if (operation.failureCode) {
    return !operation.handle && beforeAnyEffect.has(operation.failureCode) ? "did-not-turn-on" : "needs-action";
  }
  return "done";
}
