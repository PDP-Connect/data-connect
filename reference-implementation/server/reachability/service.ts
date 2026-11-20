// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type {
  ConfigurationDraft as Draft,
  Handle,
  InputRequirement,
  Configuration as ProviderConfiguration,
  ProviderInventory,
  Query,
  RunSetupOperationRequest,
  SetupOperation,
  SetupOperationRef,
  RouteView as Route,
  Candidate as RouteCandidate,
} from "@tnunamak/gozar";
import type { EarlierSetup } from "./configuration-compatibility.ts";
import type { HostSettingsBridge } from "./host-settings.ts";
import type { LifecycleEvent } from "./lifecycle.ts";
import { initialLifecycle, reduceLifecycle } from "./lifecycle.ts";
import { hostCapability, routePresentation } from "./presentation.ts";

type EmbeddingApi = ReturnType<typeof import("@tnunamak/gozar").createGozar>;
type RuntimeConsentReview = Awaited<ReturnType<typeof import("@tnunamak/gozar").reviewRouteConsent>>;

import { ReachabilityError, requireRouteApproval, requireSetupApproval } from "./approvals.ts";
import { ConfigurationDraftSession } from "./drafts.ts";
import { handleKey, type OperationRecord, type ReachabilityOperations, sameHandle } from "./operations.ts";

export { sameHandle };

/** The part of the operation journal the shutdown path writes. */
export type ShutdownJournal = Pick<ReachabilityOperations, "recordCleanupUnconfirmed" | "recordRecovered" | "requestStop">;
/**
 * Budget for closing owned routes at process shutdown. The desktop supervisor
 * sends SIGTERM to the server's process group and waits a 5 s grace before it
 * escalates to SIGKILL (stop policy in src-tauri/src/unified.rs). HTTP drain
 * (2 s, run in parallel) and storage close still follow, so the route close
 * gets 3 s, its journal writes at most 250 ms more, and 1.75 s of margin remains.
 */
export const REACHABILITY_SHUTDOWN_DEADLINE_MS = 3000;
/**
 * Cap on how long shutdown waits, after the close deadline, for the journal writes that record
 * what is still owed. Shutdown returns within the deadline plus this grace, whatever the storage does.
 */
export const SHUTDOWN_JOURNAL_GRACE_MS = 250;
/** How long past the restart deadline the caller waits for the journal's unconfirmed writes. */
export const RESTART_JOURNAL_GRACE_MS = 250;
/** The part of the operation journal the restart pass reads and writes. */
export type RestartJournal = Pick<
  ReachabilityOperations,
  "scan" | "recordAbsent" | "recordCleanupUnconfirmed" | "recordRecovered" | "requestStop"
>;
/**
 * Budget for the pass that closes routes a crashed process left behind. The
 * replacement library stops a lost owner's controller after a 20 s lease and
 * then bounds its own removal at 30 s, so a close that arrives early can wait
 * that long for the controller's attempt. The pass runs in the background with
 * the start fence held, so this bounds how long a Turn on is refused, not
 * server readiness.
 */
export const REACHABILITY_RESTART_RECONCILE_DEADLINE_MS = 75_000;
export type RestartOutcome = {
  /** Handle ids whose close this pass confirmed. */
  confirmed: string[];
  /** Handle ids not confirmed closed when the pass ended. The stop tombstone stays. */
  unconfirmed: string[];
};
export type ShutdownOutcome = {
  /** Handle ids whose close this call confirmed. */
  confirmed: string[];
  /** Handle ids still not confirmed closed when the deadline ended. The stop tombstone stays. */
  unconfirmed: string[];
};

type SetupReference = Pick<SetupOperationRef, "operationId" | "providerId">;
type SetupCommand = Pick<RunSetupOperationRequest, "actionId" | "expectedConfigurationRevision" | "expectedSetupRevision" | "draftId" | "value"> & {
  approval?: unknown;
  secret?: string;
  acknowledgeDisconnect?: boolean;
};
// `committed`: this service committed the draft, so the library already consumed it.
type SavedDraft = { providerId: string; session: ConfigurationDraftSession; committed?: boolean };
type Review = { id: string; candidate: RouteCandidate; query: Query; draftId: string };

// The address a review asks the owner to approve: the one the app named, else the
// one committed to the provider's configuration (an owner-kept address is only
// ever there). Null when the route has no owner-named address to prove.
const reviewedOrigin = (review: Review): string | null =>
  review.query.origin ?? review.candidate.configuration.values.origin ?? null;

export type HostPolicy = {
  // Host-owned query: the browser cannot choose home, owner, target or authority.
  query: Omit<Query, "providerId" | "usage">;
  identity: import("@tnunamak/gozar").HostIdentity;
  hostCapabilities: import("@tnunamak/gozar").HostCapabilities;
  hostSettings?: HostSettingsBridge;
  recoverAtBoot?: boolean;
  recoveryRetry?: Partial<RecoveryRetry>;
  readEarlierSetup?: (scopes: string[]) => Promise<EarlierSetup>;
  currentTarget?: () => Promise<string>;
  evidenceSource?: "synthetic";
  prepare: (input: { usage: Query["usage"]; reach: string; transport: string }) => Promise<void>;
  acknowledgeDisconnect: (acknowledged: boolean) => Promise<void>;
};

export type RecoveryRetry = {
  timeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random: () => number;
};
const DEFAULT_RECOVERY_RETRY: RecoveryRetry = {
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  random: Math.random,
  timeoutMs: 60_000,
};

// Attached and session routes live and die with the controller this process
// owns; a durable route outlives it.
const endsWithThisProcess = (handle: Handle): boolean => handle.kind === "attached" || handle.kind === "session";

const PROOF_REFRESH_MS = 5_000;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

// The host process owns this instance, its API and attached leases. HTTP handlers
// receive only this service; they never construct a factory or keep a lease.
export class ReachabilityService {
  private readonly api: EmbeddingApi;
  private readonly host: HostPolicy;
  private earlierSetup: EarlierSetup = null;
  private readonly drafts = new Map<string, SavedDraft>();
  private readonly reviews = new Map<string, Review>();
  private readonly routes = new Map<string, Route>();
  private recoveryPending: boolean;
  private recoveryTimedOut = false;
  private recoveryRun: Promise<{ closed: number; reproved: number; failed: number }> | null = null;
  private readonly unsettled = new Set<string>();
  private readonly externalOrigins = new Set<string>();
  private readonly runtimeReviews = new Map<string, RuntimeConsentReview>();
  private readonly watchers = new Map<string, AbortController>();
  private readonly reasons = new Map<string, string>();
  private lifecycle = initialLifecycle();
  private transition(event: LifecycleEvent): void {
    const result = reduceLifecycle(this.lifecycle, event);
    if (!result.accepted) {
      throw new ReachabilityError(result.reason);
    }
    this.lifecycle = result.state;
  }
  private starting = false;
  private startSettled: Promise<void> | null = null;
  // The route `apply` is starting. The review is gone by then and the route is not
  // yet held, yet the library probes the origin while it starts. `origin` is null
  // when the provider picks the address itself (a tunnel): nothing is known to
  // approve until the library allocates it, so the challenge answers any Host for
  // the length of the start and no longer.
  private applying: { origin: string | null } | null = null;
  private epoch = 0;
  private shutdownRun: Promise<ShutdownOutcome> | null = null;
  private restartRun: Promise<RestartOutcome> | null = null;
  // True from the moment the restart pass is requested until it settles.
  private restartPending = false;
  // Handles a previous process left that this one has not yet confirmed closed, keyed by
  // handleKey: two generations of one id are two debts.
  private readonly unreconciled = new Set<string>();
  // The one in-flight close per exact handle (handleKey). The boot pass, owner recovery, owner
  // stop and shutdown join it instead of closing the same handle twice.
  private readonly closing = new Map<string, Promise<Route>>();
  // Boot candidates not yet confirmed closed, so shutdown can journal them (keyed by handleKey).
  private readonly bootOpen = new Map<string, { handle: Handle; settleWeak: () => Promise<void> }>();
  // Journal records the boot pass could not read. Each may hide a live route.
  private journalUnreadable = 0;
  // "unavailable": the whole scan failed or missed the restart deadline, so no record
  // could be read. Reported apart from the per-record count above.
  private journalScan: "ok" | "unavailable" = "ok";

  constructor(api: EmbeddingApi, host: HostPolicy) {
    this.api = api;
    this.host = host;
    this.recoveryPending = host.recoverAtBoot === true;
  }
  private assertRecovered(): void {
    if (this.recoveryPending) {
      throw new ReachabilityError("recovery_in_progress");
    }
  }
  private ref(providerId: string, draftId: string) {
    return { draftId, home: this.host.query.home, owner: this.host.query.owner, providerId };
  }
  private draft(id: string): SavedDraft {
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new ReachabilityError("draft_not_found");
    }
    return draft;
  }
  private route(id: string, generation: number): Route {
    const route = this.routes.get(id);
    if (!route || route.handle.generation !== generation) {
      throw new ReachabilityError("route_generation_mismatch");
    }
    return route;
  }
  // The route map is keyed by id (one route per id is what the HTTP surface names). A route
  // a previous process left must never replace, or delete, the route of another handle that
  // shares its id: only the exact handle's own entry is touched.
  private retainRoute(route: Route): void {
    const held = this.routes.get(route.handle.id);
    if (!held || sameHandle(held.handle, route.handle)) this.routes.set(route.handle.id, route);
  }
  private dropRoute(handle: Handle): void {
    const held = this.routes.get(handle.id);
    if (held && sameHandle(held.handle, handle)) this.routes.delete(handle.id);
  }
  state() {
    if (this.lifecycle.phase === "verified") {
      const route = this.lifecycle.handle ? this.routes.get(this.lifecycle.handle.id) : undefined;
      const until = route?.verification.validUntil;
      if (!until?.known || !Number.isFinite(Date.parse(until.value)) || Date.parse(until.value) <= Date.now()) {
        this.transition({ type: "proof-expired" });
      }
    }
    return {
      earlierSetup: this.earlierSetup,
      evidenceSource: this.host.evidenceSource ?? null,
      lifecycle: {
        handle: this.lifecycle.handle ? { id: this.lifecycle.handle.id, generation: this.lifecycle.handle.generation, kind: this.lifecycle.handle.kind } : null,
        cleanup: this.lifecycle.cleanup,
        confinement: this.lifecycle.confinement.known
          ? { known: true as const, value: this.lifecycle.confinement.value }
          : { known: false as const, reason: this.lifecycle.confinement.reason },
        evidence: this.lifecycle.evidence,
        phase: this.lifecycle.phase,
        reason: this.lifecycle.reason,
        stopRequested: this.lifecycle.stopTombstone,
      },
      recovery: {
        actions: this.recoveryTimedOut ? ["check"] as const : [],
        blockedBy: this.recoveryTimedOut ? "recovery_timed_out" : this.unsettled.size ? "routes_unsettled" : null,
        pending: this.recoveryPending,
        unsettled: [...this.unsettled],
      },
      reasons: Object.fromEntries(this.reasons),
      journalScan: this.journalScan,
      journalUnreadable: this.journalUnreadable,
      reconciling: this.restartPending,
      routes: [...this.routes.values()],
      starting: this.starting,
    };
  }
  capabilities() {
    const ids = new Set([
      "installer.execute",
      "privilege.elevate",
      "secrets.backend",
      "runtime.attached",
      "runtime.durable",
      ...Object.keys(this.host.hostCapabilities),
    ]);
    return Object.fromEntries(
      [...ids].map((id) => {
        const observation = hostCapability(this.host.hostCapabilities, id);
        return [
          id,
          observation.known ? { known: true, value: observation.value } : { known: false, reason: observation.reason },
        ];
      })
    );
  }
  async hostSettings() {
    return this.host.hostSettings
      ? { known: true as const, value: await this.host.hostSettings.read() }
      : { known: false as const, reason: "host-supervisor-unavailable" };
  }
  async applyHostSettings(input: Parameters<HostSettingsBridge["apply"]>[0], acknowledged: boolean) {
    this.assertRecovered();
    if (!this.host.hostSettings) {
      throw new ReachabilityError("host_supervisor_unavailable");
    }
    await this.host.acknowledgeDisconnect(acknowledged);
    const before = await this.host.hostSettings.read();
    if (before.revision !== input.expectedRevision) {
      throw new ReachabilityError("configuration_stale");
    }
    this.reviews.clear();
    // Confining Off is useful even if owned resource cleanup remains uncertain.
    if (input.mode !== "off") {
      for (const route of this.routes.values()) {
        if (route.cleanup.state !== "confirmed") {
          const closed = await this.stop(route.handle.id, route.handle.generation, acknowledged);
          if (closed.cleanup.state !== "confirmed") {
            throw new ReachabilityError("cleanup_debt");
          }
        }
      }
    }
    const observed = await this.host.hostSettings.apply(input);
    this.observeHostConfinement(observed.confinement);
    if (input.mode === "off") {
      for (const route of this.routes.values()) {
        if (route.cleanup.state !== "confirmed") {
          await this.stop(route.handle.id, route.handle.generation, acknowledged);
        }
      }
    }
    if (observed.target.known) {
      this.host.query.target = observed.target.value;
    }
    return observed;
  }
  async inventory() {
    const inventory = await this.api.listProviders({ home: this.host.query.home, owner: this.host.query.owner });
    this.earlierSetup = await this.host.readEarlierSetup?.(inventory.providers.map(provider => provider.configuration.scopeId)) ?? null;
    return { ...inventory, earlierSetup: this.earlierSetup };
  }
  async begin(providerId: string, expectedConfigurationRevision: string): Promise<Draft> {
    this.assertRecovered();
    const draft = await this.api.beginConfigurationDraft({
      expectedConfigurationRevision,
      home: this.host.query.home,
      owner: this.host.query.owner,
      providerId,
    });
    this.transition({ type: "choose" });
    this.drafts.set(draft.draftId, { providerId, session: new ConfigurationDraftSession(draft) });
    return draft;
  }
  async reload(providerId: string, draftId: string): Promise<Draft> {
    const session = new ConfigurationDraftSession(null);
    const draft = await session.reload(this.api, this.ref(providerId, draftId));
    this.drafts.set(draftId, { providerId, session });
    return draft;
  }
  // Picks up a draft the host already holds (for example after a restart) so the
  // service keeps one draft. It enters the draft phase like `begin` does.
  async resume(providerId: string, draftId: string): Promise<Draft> {
    const draft = await this.reload(providerId, draftId);
    this.transition({ type: "choose" });
    return draft;
  }
  async providerLabel(providerId: string): Promise<string> {
    const inventory = await this.inventory();
    return inventory.providers.find((item) => item.providerId === providerId)?.label ?? "Selected provider";
  }
  private setupReference(input: SetupReference): SetupOperationRef {
    return { ...input, home: this.host.query.home, owner: this.host.query.owner };
  }
  readSetupOperation(reference: SetupReference): Promise<SetupOperation> {
    return this.api.readSetupOperation(this.setupReference(reference));
  }
  cancelSetupOperation(reference: SetupReference): Promise<SetupOperation> {
    return this.api.cancelSetupOperation(this.setupReference(reference));
  }
  private currentSetupAction(view: SetupOperation, input: SetupCommand) {
    const action = view.nextAction;
    const scope = action?.consent?.scope;
    if (!action || view.revision !== input.expectedSetupRevision ||
        view.scope.configurationRevision !== input.expectedConfigurationRevision ||
        view.scope.draftId !== (input.draftId ?? null) || action.id !== input.actionId ||
        scope?.operation?.id !== view.operationId || scope.operation.revision !== view.revision ||
        scope.configurationRevision !== view.scope.configurationRevision || scope.draftId !== view.scope.draftId ||
        scope.registryId !== view.scope.registryId || scope.providerId !== view.scope.providerId || scope.scopeId !== view.scope.scopeId) {
      throw new ReachabilityError("setup_scope_mismatch");
    }
    return action;
  }
  async runSetupOperation(reference: SetupReference, input: SetupCommand): Promise<SetupOperation> {
    const { actionId, expectedConfigurationRevision, expectedSetupRevision, draftId, value, secret } = input;
    const request = {
      ...this.setupReference(reference), actionId, expectedConfigurationRevision, expectedSetupRevision,
      ...(draftId === undefined ? {} : { draftId }),
    };
    if (expectedSetupRevision === 0 || input.approval === undefined) {
      if (value !== undefined || secret !== undefined || input.approval !== undefined) {
        throw new ReachabilityError("invalid_input");
      }
      return this.api.runSetupAction(request);
    }

    const view = await this.api.readSetupOperation(request);
    const action = this.currentSetupAction(view, input);
    const approval = requireSetupApproval(action, input.approval);
    if (action.kind === "open-url" || action.kind === "instructions") {
      throw new ReachabilityError("setup_action_unavailable");
    }
    if ((secret !== undefined) !== (action.kind === "provide-secret") ||
        (value !== undefined) !== (action.kind === "provide-value")) {
      throw new ReachabilityError("invalid_input");
    }
    if (["stop-connector", "remove-resource", "revoke-credential", "disconnect"].includes(action.step.purpose)) {
      await this.host.acknowledgeDisconnect(input.acknowledgeDisconnect === true);
    }
    this.reviews.clear();
    if (draftId) this.drafts.get(draftId)?.session.invalidate();
    if (secret === undefined) {
      return this.api.runSetupAction({ ...request, approval, ...(value === undefined ? {} : { value }) });
    }
    if (!action.inputId || !secret) throw new ReachabilityError("secret_input_unavailable");
    const bytes = new TextEncoder().encode(secret);
    let handle: string;
    try {
      const stored = await this.api.storeSecret({ ...request, bytes, inputId: action.inputId, scopeId: view.scope.scopeId });
      if (stored.scopeId !== view.scope.scopeId || stored.configurationRevision !== expectedConfigurationRevision) {
        throw new ReachabilityError("secret_reference_inconsistent");
      }
      handle = stored.handle;
    } finally {
      bytes.fill(0);
    }
    try {
      return await this.api.runSetupAction({ ...request, approval, secretHandle: handle });
    } finally {
      // The SDK protects handles bound to a configuration or the current setup operation.
      await this.api.discardSecret({ home: request.home, handle }).catch(() => {});
    }
  }
  async setupHandoff(reference: SetupReference, input: SetupCommand): Promise<{ href: string }> {
    if (input.secret !== undefined || input.value !== undefined) throw new ReachabilityError("invalid_input");
    const request = this.setupReference(reference);
    const view = await this.api.readSetupOperation(request);
    const action = this.currentSetupAction(view, input);
    requireSetupApproval(action, input.approval);
    if (view.state !== "pending" || action.kind !== "open-url" || !action.step.browser) {
      throw new ReachabilityError("setup_action_unavailable");
    }
    const interactive = await this.api.readSetupOperation({ ...request, includeBrowserHandoff: true });
    const offered = interactive.nextAction;
    const url = offered?.href && URL.parse(offered.href);
    if (interactive.revision !== view.revision || interactive.state !== "pending" ||
        offered?.consent.consentFactsDigest !== action.consent.consentFactsDigest ||
        !url || url.protocol !== "https:" || url.username || url.password) {
      throw new ReachabilityError("setup_action_unavailable");
    }
    return { href: url.href };
  }
  async setup(
    id: string,
    input: { actionId: string; expectedRevision: string; approval: unknown; value?: string; secret?: string }
  ): Promise<ProviderConfiguration> {
    const saved = this.draft(id);
    const prior = saved.session.snapshot;
    const action = saved.session.action(input.actionId, input.expectedRevision);
    const approval = requireSetupApproval(action, input.approval);
    if (action.step) throw new ReachabilityError("setup_required");
    const ref = this.ref(saved.providerId, id);
    this.transition({ type: "setup" });
    saved.session.invalidate();
    // After a mutation starts, no previously issued review remains redeemable.
    this.reviews.clear();
    try {
      let secretHandle: string | undefined;
      if (input.secret !== undefined) {
        const requirement = prior.configuration.inputRequirements.find(
          (field: InputRequirement) => field.actionId === action.id && field.secret
        );
        if (!requirement || action.kind !== "provide-secret") {
          throw new ReachabilityError("secret_input_unavailable");
        }
        const bytes = new TextEncoder().encode(input.secret);
        try {
          const stored = await this.api.storeSecret({
            ...ref,
            bytes,
            expectedConfigurationRevision: input.expectedRevision,
            inputId: requirement.id,
            scopeId: prior.scopeId,
          });
          if (stored.scopeId !== prior.scopeId || stored.configurationRevision !== input.expectedRevision) {
            throw new ReachabilityError("secret_reference_inconsistent");
          }
          secretHandle = stored.handle;
        } finally {
          bytes.fill(0);
        }
      }
      const result = await this.api.runSetupAction({
        ...ref,
        actionId: action.id,
        approval,
        expectedConfigurationRevision: input.expectedRevision,
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(secretHandle === undefined ? {} : { secretHandle }),
      });
      saved.session.acceptSetup(prior, result);
      this.transition({ type: "setup-complete" });
      return saved.session.snapshot.configuration;
    } catch (error) {
      const failed = reduceLifecycle(this.lifecycle, { type: "setup-failed" });
      if (failed.accepted) {
        this.lifecycle = failed.state;
      }
      throw error;
    }
  }
  async clear(
    id: string,
    input: { actionId: string; expectedRevision: string; approval: unknown }
  ): Promise<ProviderConfiguration> {
    const saved = this.draft(id);
    const prior = saved.session.snapshot;
    const action = saved.session.action(input.actionId, input.expectedRevision);
    if (!action.inputId) {
      throw new ReachabilityError("clear_input_unavailable");
    }
    const approval = requireSetupApproval(action, input.approval);
    saved.session.invalidate();
    this.reviews.clear();
    const configuration = await this.api.clearConfigurationInput({
      ...this.ref(saved.providerId, id),
      approval,
      expectedConfigurationRevision: input.expectedRevision,
      inputId: action.inputId,
    });
    saved.session.acceptClear(prior, configuration);
    return saved.session.snapshot.configuration;
  }
  async discard(id: string): Promise<{ discarded: boolean }> {
    const saved = this.draft(id);
    const result = await this.api.discardConfigurationDraft(this.ref(saved.providerId, id));
    // The library drops a draft when it is committed, so it then answers
    // discarded:false for a draft this service itself consumed. That is not
    // a draft another preparer holds: forget it locally and report it gone.
    if (result.discarded !== true && !saved.committed) return result;
    // The library discards only draft-owned, unreferenced staged bytes.
    // Promoted/live bindings remain under its authorization checks.
    this.drafts.delete(id);
    this.reviews.clear();
    // The last draft is gone, so no setup or review remains. A route that
    // is live or being stopped keeps its phase: the reducer ignores it.
    if (this.drafts.size === 0) {
      const next = reduceLifecycle(this.lifecycle, { type: "discard" });
      if (next.accepted) {
        this.lifecycle = next.state;
      }
    }

    return { discarded: true };
  }
  async commit(id: string, expectedRevision: string): Promise<ProviderConfiguration> {
    this.assertRecovered();
    if (this.configurationBusy()) {
      throw new ReachabilityError("configuration_in_use");
    }
    const saved = this.draft(id);
    if (saved.session.snapshot.configuration.revision !== expectedRevision) {
      throw new ReachabilityError("configuration_stale");
    }
    const config = await this.api.commitConfigurationDraft({
      ...this.ref(saved.providerId, id),
      expectedConfigurationRevision: expectedRevision,
    });
    saved.committed = true;
    this.reviews.clear();
    return config;
  }
  async review(id: string, usage: Query["usage"]): Promise<Review> {
    this.assertRecovered();
    const saved = this.draft(id);
    // Host preparation observes the final listener/password/port before catalog.
    const inventory = await this.inventory();
    const variants = inventory.providers.filter((item: ProviderInventory) => item.providerId === saved.providerId);
    if (variants.length !== 1 || !variants[0]) {
      throw new ReachabilityError("ambiguous_selection");
    }
    const selected = variants[0];
    if (selected.reach === "unknown") throw new ReachabilityError("unsupported", undefined, undefined, "reach_unknown");
    if (selected.availability[usage.kind]?.state !== "available") {
      throw new ReachabilityError("setup_required");
    }
    if (
      !(
        ["internet", "tailnet", "lan", "this-device"].includes(selected.reach) &&
        ["http", "https", "tcp", "tls"].includes(selected.transport)
      )
    ) {
      throw new ReachabilityError("unsupported", undefined, undefined, "provider_properties_unsupported");
    }
    await this.host.prepare({ reach: selected.reach, transport: selected.transport, usage });
    let query: Query = {
      ...this.host.query,
      intent: "create",
      target: await this.host.currentTarget?.() ?? this.host.query.target,
      providerId: saved.providerId,
      requirements: {
        ...this.host.query.requirements,
        reach: selected.reach as Query["requirements"]["reach"],
        transport: selected.transport === "http" ? "any" : (selected.transport as Query["requirements"]["transport"]),
      },
      usage,
    };
    const offer = async () => (await this.api.catalogRoutes(query)).candidates
      .find((item: RouteCandidate) => item.providerId === saved.providerId);
    let candidate = await offer();
    if (candidate?.ownership === "external-owned") {
      const { configuration } = candidate;
      const origins = configuration.inputRequirements
        .filter(field => field.kind === "https-origin" && !field.secret)
        .map(field => configuration.values[field.id])
        .filter(Boolean);
      const origin = query.origin ?? candidate.consent.scope.query.expectedOrigin ??
        (origins.length === 1 ? URL.parse(origins[0] ?? "")?.origin : undefined);
      if (!origin || usage.kind === "attached") throw new ReachabilityError("setup_required");
      query = { ...query, origin };
      candidate = await offer();
      if (candidate?.ownership !== "external-owned" ||
          candidate.consent.disclosures.ownership !== candidate.ownership ||
          candidate.consent.scope.query.expectedOrigin !== origin ||
          candidate.consent.scope.query.target !== query.target) {
        throw new ReachabilityError("candidate_stale");
      }
    }
    if (!(candidate && candidate.eligible && candidate.candidateToken)) {
      throw new ReachabilityError("setup_required");
    }
    // Every await above can let another preparer discard this draft and end
    // the lifecycle. A review for a draft that is gone must not register, and
    // the owner chain reads draft_not_found as "the state moved: restart".
    this.draft(id);
    const review = { candidate, draftId: id, id: randomUUID(), query };
    this.reviews.set(review.id, review);
    this.transition({ approvalIdentity: review.id, type: "review" });
    return review;
  }
  // The one question the ownership challenge asks: is this public authority the
  // origin the owner approved, now or earlier? Approval lives in a review being
  // shown, the route being started, or a route this process holds. Any other
  // name gets no answer. `authority` is the library verifier's own canonical
  // Host, compared with the authority of each approved origin.
  approvesChallengeAuthority(authority: string): boolean {
    if (this.applying && this.applying.origin === null) return true;
    const origins = [
      this.applying?.origin,
      ...[...this.reviews.values()].map(reviewedOrigin),
      ...this.externalOrigins,
      ...[...this.routes.values()].filter((route) => route.cleanup.state !== "confirmed").map((route) => route.origin),
    ];
    return origins.some((origin) => {
      if (!origin) return false;
      try {
        return new URL(origin).host === authority;
      } catch {
        return false;
      }
    });
  }
  operationIntent(reviewId: string) {
    const review = this.reviews.get(reviewId);
    if (!review) {
      throw new ReachabilityError("review_not_found");
    }
    return {
      bootId: this.host.identity.bootId,
      configurationRevision: review.candidate.configuration.revision,
      consentFactsDigest: review.candidate.consentFactsDigest,
      expectedOrigin: review.query.origin ?? null,
      instanceId: this.host.identity.instanceId,
      ownership: review.candidate.ownership,
      providerId: review.candidate.providerId,
      target: review.query.target,
      usage: review.query.usage,
    };
  }
  // The entry lives until the provider call itself settles. A caller may stop waiting
  // (a deadline) but a retry joins this call; it never starts a second one beside it.
  // Limitation: a provider close that never settles keeps its entry for the life of the
  // process, so repeated owner clicks join it and cannot overlap a second close. Clearing it
  // needs a provider cancellation or expiry, which the library does not offer; a restart does.
  private closeShared(handle: Handle): Promise<Route> {
    const key = handleKey(handle);
    const existing = this.closing.get(key);
    if (existing) return existing;
    // A reply that does not name this exact handle (or is not a route view) says nothing about
    // it: the outcome is unknown, exactly as for a close that throws. No caller installs it.
    const closing = this.api.closeRoute({ handle, home: this.host.query.home, mode: "remove" }).then((reply) => {
      if (!closeReplyNames(reply, handle)) throw new ReachabilityError("close_reply_mismatch");
      return reply;
    });
    this.closing.set(key, closing);
    const release = () => {
      if (this.closing.get(key) === closing) this.closing.delete(key);
    };
    closing.then(release, release);
    return closing;
  }
  /** Returns null when the library holds no route under the handle (nothing is owed). */
  async reconcileKnownHandle(handle: Handle, stopTombstone: boolean): Promise<Route | null> {
    if (stopTombstone) {
      // The lifecycle follows one route. A retry for another retained handle closes that handle
      // without rebinding, stopping or settling the route the lifecycle tracks.
      const tracked = this.lifecycle.handle;
      const own = tracked === null || sameHandle(tracked, handle);
      if (own) {
        // A retry arrives from any phase (an open review, or a stop that did not confirm).
        // Restore the intent where the lifecycle takes it; otherwise just bind the handle.
        const restored = reduceLifecycle(this.lifecycle, { handle, type: "restore-intent" });
        if (restored.accepted) this.lifecycle = restored.state;
        else this.transition({ handle, type: "recovered-handle" });
        this.transition({ type: "stop" });
      }
      let route: Route;
      try {
        route = await this.closeShared(handle);
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== "route_not_found") throw error;
        this.unreconciled.delete(handleKey(handle));
        this.dropRoute(handle);
        if (own) this.transition({ type: "cleanup-confirmed" });
        return null;
      }
      this.retainRoute(route);
      if (route.cleanup.state === "confirmed") this.unreconciled.delete(handleKey(handle));
      if (own) this.transition({ type: route.cleanup.state === "confirmed" ? "cleanup-confirmed" : "cleanup-unconfirmed" });
      return route;
    }
    this.transition({ handle, type: "restore-intent" });
    try {
      const route = await this.api.routeStatus({ handle, home: this.host.query.home });
      this.routes.set(handle.id, route);
      this.transition({ observed: "present", type: "reconcile" });
      this.watch(handle);
      return this.check(handle.id, handle.generation);
    } catch (error) {
      const failed = reduceLifecycle(this.lifecycle, { observed: "failed", type: "reconcile" });
      if (failed.accepted) {
        this.lifecycle = failed.state;
      }
      throw error;
    }
  }
  private configurationBusy(): boolean {
    return (
      this.starting ||
      this.recoveryTimedOut ||
      this.unsettled.size > 0 ||
      [...this.routes.values()].some((route) => route.cleanup.state !== "confirmed")
    );
  }
  // After a restart `routes` is empty while the library still holds what the
  // last process left. Seed from the library, then settle each owned route:
  // attached and session routes died with their controller, so close them;
  // durable routes outlive it, so prove them again under this boot's identity.
  // Old proof is never trusted. A route that stays unsettled blocks new starts
  // (see `unsettled`), as does unconfirmed cleanup, through configurationBusy().
  // Retry listRoutes with capped exponential backoff and full jitter until it
  // answers or the deadline passes. A call that hangs is abandoned at the
  // deadline too. On expiry the state is "unknown, possibly live", not off.
  private async listWithRetry(): Promise<Awaited<ReturnType<EmbeddingApi["listRoutes"]>>> {
    const policy = { ...DEFAULT_RECOVERY_RETRY, ...this.host.recoveryRetry };
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), policy.timeoutMs);
    const expired = new Promise<never>((_, reject) =>
      deadline.signal.addEventListener("abort", () => reject(new ReachabilityError("recovery_timed_out")), { once: true })
    );
    expired.catch(() => undefined);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await Promise.race([
            this.api.listRoutes({ home: this.host.query.home, owner: this.host.query.owner }),
            expired,
          ]);
        } catch (error) {
          if (deadline.signal.aborted) throw error;
          const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
          await pause(policy.random() * ceiling, deadline.signal);
          if (deadline.signal.aborted) throw new ReachabilityError("recovery_timed_out");
        }
      }
    } catch (error) {
      if (error instanceof ReachabilityError && error.code === "recovery_timed_out") {
        this.recoveryTimedOut = true;
        const unknown = reduceLifecycle(this.lifecycle, { type: "recovery-timeout" });
        if (unknown.accepted) this.lifecycle = unknown.state;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  recoverFromLibrary(): Promise<{ closed: number; reproved: number; failed: number }> {
    if (!this.recoveryRun) {
      this.recoveryPending = true;
      this.recoveryRun = this.runLibraryRecovery().finally(() => { this.recoveryRun = null; });
    }
    return this.recoveryRun;
  }
  private async runLibraryRecovery(): Promise<{ closed: number; reproved: number; failed: number }> {
    const result = { closed: 0, failed: 0, reproved: 0 };
    this.recoveryPending = true;
    try {
      const listed = await this.listWithRetry();
      if (this.recoveryTimedOut) {
        this.recoveryTimedOut = false;
        const cleared = reduceLifecycle(this.lifecycle, { type: "recovery-cleared" });
        if (cleared.accepted) this.lifecycle = cleared.state;
      }
      this.externalOrigins.clear();
      for (const route of listed.routes) {
        if (route.ownership === "external-owned" && route.origin && route.cleanup.state !== "confirmed") this.externalOrigins.add(route.origin);
      }
      const owned = listed.routes.filter((route: Route) => route.ownership === "gozar-owned");
      for (const route of owned) {
        this.routes.set(route.handle.id, route);
      }
      for (const route of owned.filter((item: Route) => item.cleanup.state !== "confirmed")) {
        const closeOnBoot = endsWithThisProcess(route.handle);
        try {
          await this.reconcileKnownHandle(route.handle, closeOnBoot);
          result[closeOnBoot ? "closed" : "reproved"]++;
        } catch {
          result.failed++;
          this.unsettled.add(route.handle.id);
        }
      }
      return result;
    } finally {
      this.recoveryPending = false;
    }
  }
  presentation(route: Route) {
    const current = route.origin
      ? {
          bootId: this.host.identity.bootId,
          handleGeneration: route.handle.generation,
          instanceId: this.host.identity.instanceId,
          origin: route.origin,
          target: this.host.query.target,
        }
      : null;
    return routePresentation(route, current, Date.now(), this.reasons.get(route.handle.id));
  }
  observeHostConfinement(confinement: import("@tnunamak/gozar").Observation<boolean>): void {
    this.transition({ confinement, type: "host-confinement" });
  }
  async observeOperationRecovery(record: OperationRecord): Promise<Route | null> {
    if (record.handle?.kind !== "external" && record.intent?.ownership !== "external-owned") return null;
    const { home, owner } = this.host.query;
    const { routes } = await this.api.listRoutes({ home, owner });
    const matches = routes.filter(route => record.handle
      ? sameHandle(route.handle, record.handle)
      : route.operationId === record.operationId);
    if (matches.length !== 1 || !matches[0] || !this.matchesExternalOperation(matches[0], record)) {
      throw new ReachabilityError("operation_recovery_unauthorized");
    }
    const route = matches[0];
    return route.state === "released" && route.cleanup.state === "confirmed" ? route : null;
  }
  private matchesExternalOperation(route: Route, record: OperationRecord): boolean {
    if (route.ownership !== "external-owned" || route.handle.kind !== "external") return false;
    // A Stop receipt already records the exact authorized handle. A start
    // receipt additionally binds recovery to the reviewed target and origin.
    if (record.kind === "stop") return record.handle?.kind === "external";
    const intent = record.intent;
    if (intent?.ownership !== "external-owned" || intent.instanceId !== this.host.identity.instanceId ||
        route.operationId !== record.operationId || !intent.expectedOrigin || route.origin !== intent.expectedOrigin) {
      return false;
    }
    // After removal Gozar forgets the target. Only the already-authorized
    // tombstone can consume that terminal observation, without closing again.
    if (record.stopTombstone && route.state === "released" && route.cleanup.state === "confirmed") return true;
    return route.hostConfiguration.target.known && route.hostConfiguration.target.value === intent.target;
  }
  async recoverOperation(
    record: OperationRecord,
    action: "check" | "stop",
    acknowledged: boolean,
    stopTombstone = false
  ): Promise<Route> {
    this.assertRecovered();
    const { operationId } = record;
    if (stopTombstone || action === "stop") {
      ++this.epoch;
      if (!this.starting) this.transition({ operationId, type: "restore-intent" });
      this.transition({ type: "stop" });
    } else {
      if (this.starting) throw new ReachabilityError("operation_in_progress");
      this.transition({ operationId, type: "restore-intent" });
    }
    let listed: Awaited<ReturnType<EmbeddingApi["listRoutes"]>>;
    try {
      listed = await this.api.listRoutes({ home: this.host.query.home, owner: this.host.query.owner });
    } catch (error) {
      const failed = reduceLifecycle(this.lifecycle, { observed: "failed", type: "reconcile" });
      if (failed.accepted) {
        this.lifecycle = failed.state;
      }
      throw error;
    }
    const matches = listed.routes.filter((route: Route) => route.operationId === operationId);
    if (matches.length !== 1 || !matches[0]) {
      const absent = reduceLifecycle(this.lifecycle, { observed: "absent", type: "reconcile" });
      if (absent.accepted) {
        this.lifecycle = absent.state;
      }
      throw new ReachabilityError("operation_not_found");
    }
    const route = matches[0];
    if (route.ownership !== "gozar-owned" && !this.matchesExternalOperation(route, record)) {
      throw new ReachabilityError("operation_recovery_unauthorized");
    }
    this.routes.set(route.handle.id, route);
    this.transition({ handle: route.handle, type: "recovered-handle" });
    if (stopTombstone || this.lifecycle.stopTombstone) {
      return this.stop(route.handle.id, route.handle.generation, acknowledged);
    }
    this.transition({ handle: route.handle, operationId, type: "restore-intent" });
    this.transition({ observed: "present", type: "reconcile" });
    this.watch(route.handle);
    return action === "stop"
      ? this.stop(route.handle.id, route.handle.generation, acknowledged)
      : this.check(route.handle.id, route.handle.generation);
  }
  // Every consent check apply makes before it has any effect, with no effect of
  // its own: nothing is written, started or deleted. The approve route runs it
  // before it answers 202, so a review that expired or changed since the owner
  // saw it is refused at once and the console can fetch a new one.
  private checkApplyNow(
    operationId: string,
    reviewId: string,
    input: { kind: unknown; consentFactsDigest: string }
  ): { review: Review; approval: ReturnType<typeof requireRouteApproval>; event: ReturnType<typeof reduceLifecycle> } {
    if (input.kind !== "route") {
      throw new ReachabilityError("consent_kind_mismatch");
    }
    const review = this.reviews.get(reviewId);
    if (!review) {
      throw new ReachabilityError("review_not_found");
    }
    const approval = requireRouteApproval(review.candidate, {
      candidateToken: review.candidate.candidateToken,
      consentFactsDigest: input.consentFactsDigest,
      disclosureRevision: review.candidate.disclosure.revision,
      kind: input.kind,
    });
    if (this.shutdownRun) {
      throw new ReachabilityError("host_supervisor_unavailable");
    }
    this.assertRecovered();
    if (this.recoveryTimedOut || this.unsettled.size > 0) throw new ReachabilityError("configuration_in_use");
    if (this.restartPending) {
      throw new ReachabilityError("operation_in_progress");
    }
    if (this.unreconciled.size > 0) {
      throw new ReachabilityError("cleanup_debt");
    }
    if (this.starting || [...this.routes.values()].some((route) => route.cleanup.state !== "confirmed")) {
      throw new ReachabilityError("configuration_in_use");
    }
    const expiry = review.candidate.expiresAt ? Date.parse(review.candidate.expiresAt) : Number.NaN;
    const event = reduceLifecycle(this.lifecycle, {
      approvalExpiresAt: expiry,
      approvalIdentity: review.id,
      now: Date.now(),
      operationId,
      type: "apply",
    });
    if (!(event.accepted && event.effects.includes("start-route"))) {
      throw new ReachabilityError("consent_expired");
    }
    return { approval, event, review };
  }
  private async checkApply(
    operationId: string,
    reviewId: string,
    input: { kind: unknown; consentFactsDigest: string }
  ): Promise<ReturnType<ReachabilityService["checkApplyNow"]>> {
    const checked = this.checkApplyNow(operationId, reviewId, input);
    if (this.host.currentTarget && (await this.host.currentTarget()) !== checked.review.query.target) {
      throw new ReachabilityError("candidate_stale");
    }
    // A slow target read must not make the read-only precheck accept an
    // expired review or lifecycle state that changed while it was pending.
    return this.checkApplyNow(operationId, reviewId, input);
  }
  /** Refuses a stale or changed review before the approval is accepted. Changes nothing. */
  async precheckApply(reviewId: string, input: { kind: unknown; consentFactsDigest: string }): Promise<void> {
    await this.checkApply("precheck", reviewId, input);
  }
  async apply(
    operationId: string,
    reviewId: string,
    input: { kind: unknown; consentFactsDigest: string; acknowledgeDisconnect: boolean }
  ): Promise<Route> {
    let checked: Awaited<ReturnType<ReachabilityService["checkApply"]>>;
    try {
      await this.checkApply(operationId, reviewId, input);
      // Revalidate after the last asynchronous read. No await may separate this
      // check from installing the lifecycle and consuming the review below.
      checked = this.checkApplyNow(operationId, reviewId, input);
    } catch (error) {
      // A review the host can no longer approve is dropped, so it is not offered again.
      const code = error instanceof ReachabilityError ? error.code : null;
      if (code === "candidate_stale" || code === "consent_expired") this.reviews.delete(reviewId);
      throw error;
    }
    const { approval, event, review } = checked;
    const applyingOrigin = reviewedOrigin(review);
    this.lifecycle = event.state;
    const epoch = ++this.epoch;
    this.starting = true;
    this.applying = { origin: applyingOrigin };
    let settled!: () => void;
    this.startSettled = new Promise<void>((resolve) => {
      settled = resolve;
    });
    this.reviews.delete(reviewId);
    try {
      await this.host.acknowledgeDisconnect(input.acknowledgeDisconnect);
      const { usage } = review.query;
      const route =
        usage.kind === "durable"
          ? await this.api.ensureRoute({ ...review.query, approval, intent: "create", operationId, usage })
          : await this.api.expose({
              ...review.query,
              approval,
              intent: "create",
              operationId,
              usage,
              wait: "verified",
            });
      this.routes.set(route.handle.id, route);
      // Policy: a start superseded while in flight (shutdown, a stop, a recovery) owns the route it
      // just created and closes it, whatever its kind, because the owner is told this Turn on
      // failed. A durable route is kept only when the start completes under its own epoch.
      if (epoch !== this.epoch) {
        // A close that does not confirm, or that throws, leaves the route owed. The failure
        // carries it, so the start's journal record keeps the exact handle for the next restart.
        // A confirmed close owes nothing, and the journal's merge never lets this record replace
        // confirmed evidence.
        let owed: Route | undefined;
        try {
          const closed = await this.stop(route.handle.id, route.handle.generation, true);
          if (closed.cleanup.state !== "confirmed") owed = owedRoute(route, [closed]);
        } catch (closeError) {
          // The close outcome is unknown. Wrap the cause; never mutate it.
          throw new ReachabilityError(
            "operation_superseded",
            owedRoute(route, [routeOn(closeError), this.routes.get(route.handle.id)]),
            closeError
          );
        }
        throw new ReachabilityError("operation_superseded", owed);
      }
      this.transition({ handle: route.handle, type: "allocated" });
      if (route.verification.status === "verified" && route.published) {
        this.transition({ epoch: this.lifecycle.epoch, type: "proof-passed" });
      }
      this.watch(route.handle);
      return route;
    } catch (error) {
      const partial = (error as import("@tnunamak/gozar").GozarThrownError | null | undefined)?.route;
      if (partial) {
        this.routes.set(partial.handle.id, partial);
        const allocated = reduceLifecycle(this.lifecycle, { handle: partial.handle, type: "allocated" });
        if (allocated.accepted) {
          this.lifecycle = allocated.state;
        }
      }
      const failed = reduceLifecycle(this.lifecycle, { type: "start-failed" });
      if (failed.accepted) {
        this.lifecycle = failed.state;
      }
      throw error;
    } finally {
      this.starting = false;
      this.applying = null;
      settled();
    }
  }
  // One watcher per route, for every route this process holds: one started here,
  // one found at boot, one recovered from an operation.
  private watch(handle: Handle): void {
    const live = this.watchers.get(handle.id);
    if (live && !live.signal.aborted) {
      return;
    }
    live?.abort();
    const abort = new AbortController();
    this.watchers.set(handle.id, abort);
    void this.observeChanges(handle, abort.signal);
    void this.refreshProof(handle, abort.signal);
  }
  private noteProof(route: Route): void {
    if (this.lifecycle.phase === "verified" && (!route.published || route.verification.status !== "verified")) {
      this.transition({ type: "proof-expired" });
    }
  }
  private async observeChanges(handle: Handle, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of this.api.watchRoutes({ handle, home: this.host.query.home, signal })) {
        if (
          !signal.aborted &&
          event.route.handle.id === handle.id &&
          event.route.handle.generation === handle.generation
        ) {
          this.routes.set(handle.id, event.route);
          if (event.type === "terminal") {
            this.unsettled.delete(handle.id);
            this.watchers.get(handle.id)?.abort();
            this.watchers.delete(handle.id);
          }
          if (event.route.state === "lost") {
            this.transition({ type: "agent-exit" });
            await this.stop(handle.id, handle.generation, true);
          } else if (event.type === "consent_changed") {
            this.transition({ type: "approval-changed" });
          } else {
            this.noteProof(event.route);
          }
        }
      }
    } catch {
      if (!signal.aborted) {
        this.reasons.set(handle.id, "route_observation_unavailable");
        if (this.lifecycle.phase === "verified") this.transition({ type: "proof-expired" });
      }
    }
  }
  // The library's watcher reports changes, not polls, and a proof timestamp is
  // not a change: left alone, a healthy route would keep its first proof and
  // read as expired once that lapsed.
  private async refreshProof(handle: Handle, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await pause(PROOF_REFRESH_MS, signal);
      if (signal.aborted) {
        return;
      }
      try {
        const current = await this.api.routeStatus({ handle, home: this.host.query.home });
        if (!signal.aborted && current.handle.generation === handle.generation) {
          this.routes.set(handle.id, current);
          this.noteProof(current);
        }
      } catch {
        // The change watcher reports a route it cannot observe; try again next round.
      }
    }
  }
  async check(id: string, generation: number): Promise<Route> {
    const route = this.route(id, generation);
    this.transition({ type: "check" });
    const epoch = this.lifecycle.epoch;
    try {
      const current = await this.api.routeStatus({ handle: route.handle, home: this.host.query.home });
      if (epoch !== this.lifecycle.epoch || this.lifecycle.stopTombstone) {
        return this.route(id, generation);
      }
      this.routes.set(id, current);
      this.unsettled.delete(id);
      this.transition({
        epoch: this.lifecycle.epoch,
        type: current.verification.status === "verified" && current.published ? "proof-passed" : "proof-failed",
      });
      return current;
    } catch (error) {
      if ((error as { code?: string }).code === "route_not_found") this.unsettled.delete(id);
      if ((error as { code?: string }).code === "proof_refresh_unsupported") {
        this.reasons.set(id, "proof_refresh_unsupported");
        this.transition({ type: "proof-refresh-unsupported" });
      } else {
        const failed = reduceLifecycle(this.lifecycle, { type: "proof-failed" });
        if (failed.accepted) {
          this.lifecycle = failed.state;
        }
      }
      throw error;
    }
  }
  routeReference(id: string, generation: number): Handle {
    return this.route(id, generation).handle;
  }
  async authorizeDisconnect(acknowledged: boolean): Promise<void> {
    await this.host.acknowledgeDisconnect(acknowledged);
  }
  async stop(id: string, generation: number, acknowledged: boolean): Promise<Route> {
    const route = this.route(id, generation);
    await this.host.acknowledgeDisconnect(acknowledged);
    if (route.cleanup.state === "confirmed") {
      this.watchers.get(id)?.abort();
      this.watchers.delete(id);
      const closed = await this.closeShared(route.handle);
      this.routes.set(id, closed);
      return closed;
    }
    this.transition({ type: "stop" });
    ++this.epoch;
    this.reviews.clear();
    this.runtimeReviews.delete(id);
    this.watchers.get(id)?.abort();
    this.routes.set(id, { ...route, published: null });
    const closed = await this.closeShared(route.handle);
    this.routes.set(id, closed);
    if (closed.cleanup.state === "confirmed") {
      this.unreconciled.delete(handleKey(route.handle));
      this.unsettled.delete(id);
    }
    this.transition({ type: closed.cleanup.state === "confirmed" ? "cleanup-confirmed" : "cleanup-unconfirmed" });
    return closed;
  }
  async reviewRuntime(id: string, generation: number): Promise<RuntimeConsentReview> {
    const route = this.route(id, generation);
    try {
      const review = await this.api.reviewRouteConsent({ handle: route.handle, home: this.host.query.home });
      this.runtimeReviews.set(id, review);
      return review;
    } catch (error) {
      if ((error as { code?: string }).code === "proof_refresh_unsupported") {
        this.reasons.set(id, "proof_refresh_unsupported");
        this.transition({ type: "proof-refresh-unsupported" });
        this.routes.set(id, { ...route, actions: ["stop"], published: null });
      }
      throw error;
    }
  }
  async approveRuntime(id: string, generation: number, digest: string): Promise<Route> {
    const route = this.route(id, generation);
    const review = this.runtimeReviews.get(id);
    if (!review || review.consentFactsDigest !== digest) {
      throw new ReachabilityError("consent_changed");
    }
    this.runtimeReviews.delete(id);
    const current = await this.api.approveRouteConsent({
      approvalToken: review.approvalToken,
      consentFactsDigest: digest,
      handle: route.handle,
      home: this.host.query.home,
    });
    this.routes.set(id, current);
    return current;
  }
  /**
   * Closes every attached route this host owns, within `deadlineMs`, for the
   * process shutdown path. Idempotent: later calls return the first run.
   *
   * Order: refuse new starts, journal a Stop tombstone, withdraw publication,
   * then close with the retained exact handle. A route the host does not own
   * (external) or that outlives the process by design (durable, session) is not
   * touched. A route not confirmed closed by the deadline keeps its tombstone
   * and is journaled as cleanup unconfirmed; success is never recorded for it.
   */
  shutdown(deadlineMs: number, journal: ShutdownJournal): Promise<ShutdownOutcome> {
    this.shutdownRun ??= this.runShutdown(deadlineMs, journal);
    return this.shutdownRun;
  }
  private async runShutdown(deadlineMs: number, journal: ShutdownJournal): Promise<ShutdownOutcome> {
    // Fence first. The epoch bump makes a start still awaiting the library close
    // its own route when it returns.
    this.epoch += 1;
    this.reviews.clear();
    this.runtimeReviews.clear();
    this.closeObservers();
    // Shutdown is best effort per step: a failed journal write must not stop the close.
    const ignore = () => undefined;
    const owned = () =>
      [...this.routes.values()].filter(
        (route) => hostStartedKind(route.handle) && route.ownership === "gozar-owned"
      );
    const confirmed = new Map<string, Handle>();
    // Best-effort lifecycle bookkeeping for the route the lifecycle tracks.
    const advance = (handle: Handle, type: "stop" | "cleanup-confirmed" | "cleanup-unconfirmed") => {
      const event = reduceLifecycle(this.lifecycle, { type });
      if (event.accepted && this.lifecycle.handle && sameHandle(this.lifecycle.handle, handle)) {
        this.lifecycle = event.state;
      }
    };
    const close = async (): Promise<void> => {
      // Already-known routes close at once: an embedded provider start that never
      // returns must not hold back their closes. A start still in flight allocates
      // its handle only when it returns, so its route - if any - is swept after the
      // start settles, and the single-flight close keeps the two passes off one
      // exact handle. The sweep runs under the same deadline as everything else,
      // so a start that never settles ends at the deadline, after the known closes
      // were already dispatched.
      const dispatched = new Set<string>();
      const one = async (route: Route): Promise<void> => {
        const { handle } = route;
        dispatched.add(handleKey(handle));
        // The tombstone is journaled beside the close, never ahead of it: a stalled journal
        // must not keep the provider call from starting. If the process dies before the tombstone
        // lands, the record still has no cleanup evidence, so the next boot closes the handle.
        if (route.operationId) void journal.requestStop(route.operationId).catch(ignore);
        advance(handle, "stop");
        if (route.cleanup.state !== "confirmed") {
          this.routes.set(handle.id, { ...route, published: null });
          const closed = await this.closeShared(handle);
          this.routes.set(handle.id, closed);
          if (closed.cleanup.state !== "confirmed") {
            return;
          }
        }
        confirmed.set(handleKey(handle), handle);
        advance(handle, "cleanup-confirmed");
        if (route.operationId) {
          await journal.recordRecovered(route.operationId, this.routes.get(handle.id) ?? route).catch(ignore);
        }
      };
      const sweepLateAllocation = (this.startSettled ?? Promise.resolve()).then(
        async () => {
          await Promise.all(
            owned().filter((route) => !dispatched.has(handleKey(route.handle))).map((route) => one(route))
          );
        },
        () => undefined
      );
      await Promise.all([...owned().map((route) => one(route)), sweepLateAllocation]);
    };
    // Budget: `deadlineMs` bounds the close work, then one capped grace
    // (SHUTDOWN_JOURNAL_GRACE_MS) bounds the journal writes for what is still owed. Nothing
    // below waits on a journal or provider promise outside those two bounds. A write that does not
    // land in time keeps running; until it lands the record stays a restart candidate.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
    });
    try {
      // The boot pass may be closing routes only the journal knows. Join it.
      await Promise.race([Promise.all([close().catch(ignore), this.restartRun?.catch(ignore)]), deadline]);
    } finally {
      clearTimeout(timer);
    }
    const unconfirmed = owned().filter((route) => !confirmed.has(handleKey(route.handle)));
    // Boot candidates still owed: their own settlement writes the unconfirmed record.
    const owedAtBoot = [...this.bootOpen.entries()].filter(
      ([key]) =>
        this.unreconciled.has(key) && !confirmed.has(key) && !unconfirmed.some((route) => handleKey(route.handle) === key)
    );
    const debtWrites = [
      ...unconfirmed.map(async (route) => {
        advance(route.handle, "cleanup-unconfirmed");
        if (route.operationId) {
          await journal.recordCleanupUnconfirmed(route.operationId, route.handle).catch(ignore);
        }
      }),
      ...owedAtBoot.map(([, candidate]) => candidate.settleWeak().catch(ignore)),
    ];
    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(debtWrites),
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, SHUTDOWN_JOURNAL_GRACE_MS);
        }),
      ]);
    } finally {
      clearTimeout(grace);
    }
    return {
      confirmed: [...confirmed.values()].map((handle) => handle.id),
      unconfirmed: [...unconfirmed.map((route) => route.handle.id), ...owedAtBoot.map(([, candidate]) => candidate.handle.id)],
    };
  }
  /**
   * Closes the attached and session routes a crashed process left behind, within
   * `deadlineMs`. Call once at startup, before the HTTP surface accepts a start.
   * The start fence is held until the pass settles; the pass itself runs
   * without blocking the caller's readiness. Idempotent.
   *
   * Only a journaled start with an attached or session, library-owned handle whose cleanup
   * the journal never confirmed is closed, with its exact retained handle. A
   * crashed owner's route is never adopted as the current route. External
   * and durable routes are not touched. A close that is not confirmed
   * keeps the Stop tombstone, journals cleanup unconfirmed, and leaves the
   * handle in `unreconciled`: a Turn on is refused as `cleanup_debt` until an
   * owner stop confirms it.
   */
  reconcileAfterRestart(deadlineMs: number, journal: RestartJournal): Promise<RestartOutcome> {
    if (!this.restartRun) {
      // Raised synchronously, so a start cannot slip in before the first await.
      this.restartPending = true;
      this.restartRun = this.runRestartReconcile(deadlineMs, journal).finally(() => {
        this.restartPending = false;
      });
    }
    return this.restartRun;
  }
  private async runRestartReconcile(deadlineMs: number, journal: RestartJournal): Promise<RestartOutcome> {
    // One deadline bounds everything the caller waits for: the scan, the closes and their
    // journal writes. Work still running at the deadline continues as recoverable debt.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), deadlineMs);
    });
    try {
      return await this.restartPass(journal, deadline);
    } finally {
      clearTimeout(timer);
    }
  }
  private async restartPass(journal: RestartJournal, deadline: Promise<"deadline">): Promise<RestartOutcome> {
    const ignore = () => undefined;
    let scanned: Awaited<ReturnType<RestartJournal["scan"]>>;
    try {
      const result = await Promise.race([journal.scan(), deadline]);
      if (result === "deadline") throw new Error("deadline");
      scanned = result;
    } catch (error) {
      // An unreadable journal cannot name a route to close. Do not hold the fence forever.
      this.journalScan = "unavailable";
      console.error(`[reachability] restart reconcile could not read the journal: ${(error as Error)?.message ?? typeof error}`);
      return { confirmed: [], unconfirmed: [] };
    }
    this.journalScan = "ok";
    // Unreadable receipts may hide a live route. The owner sees the count; Turn on is not
    // refused, because nothing the owner can press would clear it.
    this.journalUnreadable = scanned.unreadable;
    const pending = restartCandidates(scanned.records);
    for (const { handle } of pending) this.unreconciled.add(handleKey(handle));
    // Each candidate has one settlement. A strong outcome (confirmed, or the library holds no
    // such route) is final: a weak one (unconfirmed) never lands after it, and writes run in order.
    // Keyed by handleKey throughout: candidates may share an id across generations.
    const results = new Map<string, "confirmed" | "unconfirmed">();
    const candidates = pending.map(({ handle, operationId }) => {
      const key = handleKey(handle);
      let strong = false;
      let chain: Promise<unknown> = Promise.resolve();
      const settle = (final: boolean, memory: () => void, write: () => Promise<unknown>) => {
        if (strong && !final) return chain;
        if (final) strong = true;
        memory();
        chain = chain.then(write).catch(ignore);
        return chain;
      };
      const forget = () => {
        this.unreconciled.delete(key);
        this.dropRoute(handle);
        this.bootOpen.delete(key);
      };
      const unconfirmedWrite = () => journal.recordCleanupUnconfirmed(operationId, handle);
      const settleWeak = async () => {
        await settle(false, () => undefined, unconfirmedWrite);
      };
      this.bootOpen.set(key, { handle, settleWeak });
      const attempt = async () => {
        await journal.requestStop(operationId).catch(ignore);
        try {
          const route = await this.closeShared(handle);
          if (route.cleanup.state === "confirmed") {
            results.set(key, "confirmed");
            await settle(true, forget, () => journal.recordRecovered(operationId, route));
            return;
          }
          results.set(key, "unconfirmed");
          await settle(false, () => this.retainRoute(route), unconfirmedWrite);
        } catch (error) {
          // No such route: the library holds nothing under this handle, so nothing is owed.
          // An owner stop would get the same answer, so keeping debt would block Turn on for good.
          if ((error as { code?: string } | null)?.code === "route_not_found") {
            results.set(key, "confirmed");
            await settle(true, forget, () => journal.recordAbsent(operationId));
            return;
          }
          // Otherwise the library refused or failed; the route may still be live.
          results.set(key, "unconfirmed");
          await settle(false, () => undefined, unconfirmedWrite);
        }
      };
      return { attempt, handle, settleWeak };
    });
    if (this.shutdownRun) {
      await Promise.race([Promise.all(candidates.map((candidate) => candidate.settleWeak())), deadline]);
      return { confirmed: [], unconfirmed: pending.map(({ handle }) => handle.id) };
    }
    const attempts = candidates.map((candidate) => candidate.attempt().catch(ignore));
    await Promise.race([Promise.all(attempts), deadline]);
    // Candidates with no result at the deadline are unconfirmed. Their weak write gets a short
    // grace so a healthy journal has it on disk at return; slow storage must not hold the
    // outcome past that. The write runs on, and until it lands the record stays a candidate for
    // the next boot. A close that answers later still settles through the same ordered write and
    // may only improve the journal, never this outcome.
    const lateWrites = candidates.filter(({ handle }) => !results.has(handleKey(handle))).map(({ settleWeak }) => settleWeak().catch(ignore));
    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(lateWrites),
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, RESTART_JOURNAL_GRACE_MS);
        }),
      ]);
    } finally {
      clearTimeout(grace);
    }
    const outcome: RestartOutcome = { confirmed: [], unconfirmed: [] };
    const owed: Handle[] = [];
    for (const { handle } of pending) {
      if (results.get(handleKey(handle)) === "confirmed") outcome.confirmed.push(handle.id);
      else {
        outcome.unconfirmed.push(handle.id);
        owed.push(handle);
      }
    }
    // Show the first unconfirmed route as stopping, never as the current route:
    // the tombstone is set, so it cannot be checked or kept.
    const shown = owed
      .map((handle) => this.routes.get(handle.id))
      .find((route) => route !== undefined && owed.some((handle) => sameHandle(handle, route.handle)));
    if (shown && this.lifecycle.phase === "inactive") {
      for (const event of [
        { handle: shown.handle, type: "restore-intent" },
        { type: "stop" },
        { type: "cleanup-unconfirmed" },
      ] as const) {
        const next = reduceLifecycle(this.lifecycle, event);
        if (next.accepted) this.lifecycle = next.state;
      }
    }
    return outcome;
  }
  closeObservers(): void {
    for (const watcher of this.watchers.values()) {
      watcher.abort();
    }
    this.watchers.clear();
  }
}

/**
 * Journaled starts a crashed process may have left live: attached or session, library-owned,
 * with a retained handle, and no cleanup evidence. Evidence is a start record whose
 * `cleanupConfirmed` is true (a close confirmed, or the library reported the route
 * absent), or a settled owner stop for the same handle with `cleanupConfirmed`
 * true. A Stop intent alone is not evidence, and neither is a record that predates
 * the field: both stay candidates, which costs one idempotent close. An owner stop
 * whose close did not confirm settles too, so the route can offer its retry, but it
 * leaves the route a candidate.
 */
/**
 * Route kinds whose lifetime this host owns. An attached route dies with its caller;
 * a session route runs on a detached daemon that outlives it, so the host must close
 * both. Durable and external routes are never the host's to close.
 */
function hostStartedKind(handle: Handle): boolean {
  return handle.kind === "attached" || handle.kind === "session";
}


/** True when a close reply is a route view naming exactly `handle`. Reads nothing it cannot bound. */
function closeReplyNames(reply: unknown, handle: Handle): boolean {
  try {
    const view = reply as Route | null | undefined;
    return !!view && typeof view.cleanup?.state === "string" && sameHandle(view.handle, handle);
  } catch {
    return false;
  }
}

/** The route a throw carries, if any, read without trusting the thrown value. */
function routeOn(thrown: unknown): Route | null {
  try {
    return (thrown as { route?: Route } | null | undefined)?.route ?? null;
  } catch {
    return null;
  }
}

// The only cleanup states close evidence may contribute. "confirmed" is never taken from it here.
const OWED_CLEANUP_STATES = new Set<string>(["none", "unconfirmed"]);

/**
 * The route a superseded start still owes. It is built from the allocation's own fields: the
 * evidence it may add is one cleanup state, from a view naming the allocation's exact handle and
 * from a known set. Every read of a view is guarded, so a malformed view cannot throw here. Stop
 * has withdrawn publication, so the route is never published, and a thrown or partial close is
 * never recorded as confirmed.
 */
function owedRoute(allocation: Route, views: unknown[]): Route {
  let state: string = allocation.cleanup.state;
  for (const view of views) {
    try {
      const candidate = view as Route | null | undefined;
      const seen = candidate?.cleanup?.state;
      if (candidate && sameHandle(candidate.handle, allocation.handle) && typeof seen === "string" && OWED_CLEANUP_STATES.has(seen)) {
        state = seen;
        break;
      }
    } catch {
      // A malformed view is ignored.
    }
  }
  return {
    ...allocation,
    cleanup: { nextAction: null, state: (OWED_CLEANUP_STATES.has(state) ? state : "unconfirmed") as Route["cleanup"]["state"] },
    published: null,
  };
}

export function restartCandidates(records: OperationRecord[]): { handle: Handle; operationId: string }[] {
  const ownerStopped = (handle: Handle) =>
    records.some(
      (record) =>
        record.kind === "stop" &&
        record.stage === "settled" &&
        record.failureCode === null &&
        record.cleanupConfirmed === true &&
        record.handle !== null &&
        sameHandle(record.handle, handle)
    );
  const seen: Handle[] = [];
  const found: { handle: Handle; operationId: string }[] = [];
  for (const record of records) {
    const { handle } = record;
    if (record.kind !== "start" || !handle || !hostStartedKind(handle) || record.intent?.ownership !== "gozar-owned") continue;
    if (record.stage === "settled" && record.cleanupConfirmed === true) continue;
    if (ownerStopped(handle) || seen.some((other) => sameHandle(other, handle))) continue;
    seen.push(handle);
    found.push({ handle, operationId: record.operationId });
  }
  return found;
}
