"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { HostSettings } from "pdpp-reference-implementation/reachability-host-settings";
import type {
  projectInventory,
  projectRoute,
  projectRuntimeReview,
} from "pdpp-reference-implementation/reachability-projection";
import { useCallback, useEffect, useRef, useState } from "react";
import { migrateLegacySetupReservations } from "../../../lib/legacy-setup-reservations.ts";
import { requestOwnerPasswordWindowAction } from "./owner-password-first-setup-actions.ts";
import { ProviderSetup } from "./provider-setup.tsx";
import { type ServiceEntry, setupCards } from "./setup-services.ts";
import { requestReachability } from "./reachability-actions.ts";
import { OnCard } from "./on-card.tsx";
import { type Attention, attentionSentence, proofLine, recheckDelay, routeAttention, routeHeadline, routeSentence } from "./route-display.ts";
import {
  type DisplayError,
  Diagnostics,
  DiagnosticsContext,
  ErrorNotice,
  type Recover,
  RecoveryContext,
  ReachabilityFailure,
  toDisplayError,
} from "./diagnostics.tsx";
import { formatLocalTime, plain } from "./plain-text.ts";
import { type ActionKind, CLEANUP_UNCONFIRMED, ERROR_MESSAGES, publicError } from "./reachability-errors.ts";
import { ConsentFacts, RuntimeRouteConsentCard, splitFacts, UnknownFactsCount } from "./reachability-consent.tsx";
import {
  type Action,
  type Draft,
  type Prepared,
  PreparationStopped,
  type Review,
  changedFacts,
  operationOutcome,
  pickUsage,
  prepareTurnOn,
  reviewExpired,
  runAction,
  staleReviewCodes,
} from "./prepare-remote-access.ts";
import { OtherWays, RecommendedWay } from "./choose-way.tsx";
import {
  type Blocks,
  funnelPolicyActionId,
  funnelPolicyBlock,
  recommendedWay,
  wayRow,
  wayUnusable,
} from "./choose-way.ts";
import { AllowCard, TurnOnCard, TurningOnChecklist, checklistStep } from "./turn-on.tsx";

type Inventory = ReturnType<typeof projectInventory>;
type Route = ReturnType<typeof projectRoute>;
type Operation = {
  failureCode?: string | null;
  handle?: unknown;
  kind?: "start" | "stop" | "check";
  operationId: string;
  stage: string;
  recovery: { available: boolean; reason: string } | null;
};
type State = {
  evidenceSource?: "synthetic" | null;
  operations?: Operation[];
  lifecycle?: {
    handle: Route["handle"] | null;
    phase: string;
    confinement: { known: boolean; value?: boolean };
    cleanup: string;
    reason?: string | null;
    stopRequested: boolean;
  };
  routes: Route[];
  reasons: Record<string, string>;
  services?: ServiceEntry[];
  /** False while the owner has not chosen a password. Absent means there is nothing to ask. */
  passwordSet?: boolean;
  starting: boolean;
};
// What the preparation chain has produced for the way on screen.
type Prep =
  | { status: "idle" }
  | { status: "preparing" }
  | { status: "done"; providerId: string; result: Prepared };

export function RemoteAccessSetting({
  request = requestReachability,
  appVersion,
}: {
  request?: typeof requestReachability;
  appVersion?: string;
}) {
  const [host, setHost] = useState<{ known: true; value: HostSettings } | { known: false; reason: string }>({
    known: false,
    reason: "loading",
  });
  const [port, setPort] = useState("");
  const [capabilities, setCapabilities] = useState<
    Record<string, { known: boolean; value?: boolean | string; reason?: string }>
  >({});
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [state, setState] = useState<State>({ routes: [], reasons: {}, starting: false });
  const [stateLoaded, setStateLoaded] = useState(false);
  // The way on screen, owned here. It is set when the owner picks a way and
  // when preparation starts for one. After that a catalog poll changes only
  // which way carries the Recommended badge, never the way being prepared.
  const [pinned, setPinned] = useState<string | null>(null);
  // Ways whose own setup ended blocked on an administrator step.
  const [blocks, setBlocks] = useState<Blocks>({});
  // Why the console moved off a way the owner was on.
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  // Bumped whenever the way on screen changes. A preparation or click binds to
  // the value it started with and sends nothing positive once it has moved on.
  const selection = useRef(0);
  const [showOtherWays, setShowOtherWays] = useState(false);
  const [declined, setDeclined] = useState<string | null>(null);
  const [prep, setPrep] = useState<Prep>({ status: "idle" });
  const [prepError, setPrepError] = useState<DisplayError | null>(null);
  // Bumped to run the preparation chain again.
  const [prepRun, setPrepRun] = useState(0);
  // Labels of facts that changed since the owner last saw the review.
  const [changed, setChanged] = useState<string[] | null>(null);
  const shownReview = useRef<Review | null>(null);
  const [runtimeReview, setRuntimeReview] = useState<{
    routeId: string;
    generation: number;
    snapshot: ReturnType<typeof projectRuntimeReview>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  // After Cancel: the host is turning it off, or could not confirm it is off.
  const [cancel, setCancel] = useState<"stopping" | "unconfirmed" | null>(null);
  // Automatic proof re-check. `rechecking` holds routes with a check under way;
  // `recheckFailure` the code of one that failed; `rechecked` the proof windows
  // already re-checked, so one window is checked once.
  const [rechecking, setRechecking] = useState<ReadonlySet<string>>(new Set());
  const [recheckFailure, setRecheckFailure] = useState<Readonly<Record<string, string>>>({});
  const [rechecked, setRechecked] = useState<ReadonlySet<string>>(new Set());
  // Routes the owner has moved past by choosing Turn on again or Turn off.
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  // The address the owner had before Turn on again, to tell if it changed.
  const [previousOrigin, setPreviousOrigin] = useState<string | null>(null);
  // Set by Turn on again: the digest of the facts the owner last approved.
  const againPending = useRef(false);
  // The digest of the facts the owner approved with the last Turn on click.
  const approvedDigest = useRef<string | null>(null);
  // One preparation at a time per selection token, never across superseded ways.
  const preparing = useRef<{ token: number; tail: Promise<unknown> } | null>(null);
  // The expired review whose refresh is under way. The expiry timer starts no
  // second refresh for it.
  const refreshing = useRef<string | null>(null);
  const mounted = useRef(true);
  // The poll, so a repair can read the host again at once.
  const loadRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reservations = setupCards(state.services);
  // Bumped when an action starts and when it ends. A poll started in an earlier
  // epoch is dropped. `loadSeq` and `appliedSeq` order the polls themselves.
  const actionEpoch = useRef(0);
  const loadSeq = useRef(0);
  const appliedSeq = useRef(0);
  const seenSetup = useRef<string | null>(null);
  // Bumped by each poll above; a sign-in the owner is finishing reads its setup on each bump.
  const [setupTick, setSetupTick] = useState(0);

  async function send<T>(path: string, input?: Record<string, unknown>): Promise<T> {
    const result = await request(path, input);
    if (!result.ok) {
      throw new ReachabilityFailure(result);
    }
    return result.data as T;
  }
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = async () => {
      const seq = ++loadSeq.current;
      const startedInEpoch = actionEpoch.current;
      const [catalogResult, stateResult, hostResult, capabilityResult] = await Promise.all([
        request("/catalog"),
        request("/state"),
        request("/host-settings"),
        request("/host-capabilities"),
      ]);
      // A poll reports on the moment it started. If an action began or ended
      // since, or a later poll already landed, this answer is out of date and
      // must not replace what the action or the later poll set.
      const outdated = () => !active || seq < appliedSeq.current || startedInEpoch !== actionEpoch.current;
      if (outdated()) {
        return;
      }
      appliedSeq.current = seq;
      // The first read that failed names the problem; a later one that succeeds clears it.
      const failedRead = !catalogResult.ok ? catalogResult : !stateResult.ok ? stateResult : null;
      if (catalogResult.ok) {
        setInventory(catalogResult.data as Inventory);
        setStale(false);
      } else {
        setStale(true);
      }
      if (failedRead) {
        setError((current) =>
          current?.source === "action" || (current?.source === "load" && current.code === failedRead.code)
            ? current
            : toDisplayError(new ReachabilityFailure(failedRead), "load")
        );
      }
      if (hostResult.ok) {
        setHost(hostResult.data as typeof host);
      }
      if (capabilityResult.ok) {
        setCapabilities(capabilityResult.data as typeof capabilities);
      }
      if (stateResult.ok) {
        const next = stateResult.data as State;
        setState(next);
        setStateLoaded(true);
        if (next.operations?.length) {
          setOperation((current) => (current?.stage === "applying" ? current : (next.operations?.[0] ?? current)));
        }
      } else {
        setStale(true);
      }
      // A load that succeeds retires the load error it replaced; an action error stays until the next action.
      if (catalogResult.ok && stateResult.ok) {
        setError((current) => (current?.source === "load" ? null : current));
      }
    };
    loadRef.current = load;
    // Setups an older console kept in the browser move to the host first, and
    // polling starts only after that finishes.
    void migrateLegacySetupReservations(request)
      .catch(() => undefined)
      .then(async () => {
        if (!active) {
          return;
        }
        const refresh = () => {
          void load().catch((failure) => {
            if (active) {
              setStale(true);
              setError((current) => current?.source === "action" ? current : toDisplayError(failure, "load"));
            }
          });
        };
        // Setup observations must not wait on unrelated dashboard requests.
        timer = setInterval(() => {
          setSetupTick((n) => n + 1);
          refresh();
        }, 3000);
        refresh();
      });
    return () => {
      active = false;
      if (timer !== undefined) {
        clearInterval(timer);
      }
    };
  }, [request]);

  useEffect(() => {
    if (!operation || operation.stage !== "applying") {
      return;
    }
    let active = true;
    const timer = setInterval(() => {
      void request(`/operations/${encodeURIComponent(operation.operationId)}`).then((result) => {
        if (active && result.ok) {
          setOperation((current) => ({ ...(result.data as Operation), kind: (result.data as Operation).kind ?? current?.kind }));
        }
      });
    }, 500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [operation, request]);

  useEffect(() => {
    if (!operation || operation.stage === "applying") {
      return;
    }
    let active = true;
    void request("/state").then((result) => {
      if (!active) return;
      if (result.ok) {
        setState(result.data as State);
        setStale(false);
      } else {
        setStale(true);
      }
    });
    return () => { active = false; };
  }, [operation, request]);

  const recommended = inventory ? recommendedWay(inventory, capabilities, blocks) : undefined;
  const pinnedWay = inventory && pinned ? inventory.providers.find((item) => item.providerId === pinned) : undefined;
  // The pinned way stays until it truly cannot be used: a way whose prerequisite
  // is only unreadable for a moment is not one.
  const way = pinnedWay && !wayUnusable(pinnedWay, capabilities, blocks) ? pinnedWay : recommended;
  const wayUsage = way ? pickUsage(way, capabilities) : null;
  const wayId = way?.providerId ?? null;
  const wayLabel = way ? plain(way.label) : undefined;
  // Read by a sign-in step already under way: it must not show or open for a way the owner has left.
  const wayIdNow = useRef<string | null>(null);
  wayIdNow.current = wayId;

  const mutationBlocked = busy || stale || state.starting;
  // The password is the only gate on an address reachable from the internet,
  // so nothing can be turned on until the owner has chosen one.
  const passwordMissing = state.passwordSet === false;
  // Read by actions already under way, which can outlive the state they started in.
  const passwordMissingNow = useRef(false);
  passwordMissingNow.current = passwordMissing;
  const requirePassword = () => {
    if (passwordMissingNow.current) throw new ReachabilityFailure(publicError("owner_password_required"));
  };
  // Serialize only within the current selection. A hung superseded selection
  // must not hold up a new way; both chains retain their positive-request guards.
  function prepare(providerId: string, usage: string, isCurrent: () => boolean): Promise<Prepared> {
    const token = selection.current;
    const previous = preparing.current?.token === token ? preparing.current.tail : Promise.resolve();
    const run = previous.then(() => {
      if (!isCurrent()) throw new PreparationStopped();
      return prepareTurnOn(request, { providerId, usage }, {
        isCurrent,
        mayRunActions: () => !passwordMissingNow.current,
        onPasswordMissing: () => {
          if (!isCurrent()) return;
          passwordMissingNow.current = true;
          setState((current) => ({ ...current, passwordSet: false }));
        },
      });
    });
    preparing.current = { token, tail: run.catch(() => undefined) };
    return run;
  }
  const phaseOf = (route: Route) => (state.lifecycle?.handle?.id === route.handle.id ? (state.lifecycle?.phase ?? null) : null);
  const unsupportedOf = (route: Route) => state.reasons[route.handle.id] === "proof_refresh_unsupported";
  // The route whose proof the app renews before its window ends: still verified
  // (or just past its window, with no check yet), not stopping, not given up on.
  const recheckTarget = (() => {
    for (const route of state.routes) {
      const phase = phaseOf(route);
      const delay = recheckDelay(route, phase);
      if (
        (phase === "verified" || phase === "stale") &&
        delay !== null &&
        route.cleanup.state !== "confirmed" &&
        !state.lifecycle?.stopRequested &&
        !unsupportedOf(route) &&
        !(route.handle.id in recheckFailure) &&
        !acknowledged.has(route.handle.id)
      ) {
        const until = route.verification.validUntil;
        const key = `${route.handle.id}:${route.handle.generation}:${until?.known ? until.value : ""}`;
        return { route, delay, key };
      }
    }
    return null;
  })();
  const recheckPending = (route: Route) =>
    recheckTarget?.route.handle.id === route.handle.id && !rechecked.has(recheckTarget.key);
  const recheckUnderWay = (route: Route) => rechecking.has(route.handle.id) || recheckPending(route);
  // While a re-check is pending or under way the status stays On: neither
  // "checking" nor "stale" reaches the owner.
  const shownPhase = (route: Route) => {
    const phase = phaseOf(route);
    return recheckUnderWay(route) && (phase === "checking" || phase === "stale") ? "verified" : phase;
  };
  const attentionOf = (route: Route): Attention | null =>
    routeAttention(route, {
      lifecycleReason: state.lifecycle?.handle?.id === route.handle.id ? (state.lifecycle?.reason ?? null) : null,
      recheckFailed: route.handle.id in recheckFailure,
      acknowledged: acknowledged.has(route.handle.id),
      now: Date.now(),
      lifecyclePhase: phaseOf(route),
      recheckUnderWay: recheckUnderWay(route),
    });
  const headlineOf = (route: Route) =>
    routeHeadline(route, shownPhase(route), unsupportedOf(route), attentionOf(route));
  const routesOff = state.routes.every((route) => headlineOf(route) === "Off");
  const outcome = operation ? operationOutcome(operation) : null;
  // Preparation runs only while nothing is on or on its way. A finished
  // start waits for the next state read to show its address.
  const idle =
    stateLoaded &&
    !stale &&
    !state.starting &&
    routesOff &&
    (!operation ||
      outcome === "did-not-turn-on" ||
      (outcome === "done" && state.routes.length > 0 && operation.kind !== "start"));
  const readyToPrepare = idle && !passwordMissing && wayId !== null && wayUsage !== null && declined !== wayId;

  // Preparation for a way pins it. If that replaces a way the owner was on,
  // the old way could no longer be used: say why.
  useEffect(() => {
    if (!wayId && pinnedWay && wayUnusable(pinnedWay, capabilities, blocks)) {
      selection.current += 1;
      const from = wayRow(pinnedWay, capabilities, blocks);
      setSwitchNote(`${from.title} can\'t be used now: ${from.missing?.text ?? "No usable way is available."}`);
      return;
    }
    if (!readyToPrepare || !way || !wayId || pinned === wayId) return;
    if (pinned !== null) {
      selection.current += 1;
      const from = pinnedWay ? wayRow(pinnedWay, capabilities, blocks) : null;
      setSwitchNote(
        from
          ? `${from.title} can't be used now${from.missing ? `: ${from.missing.text}` : "."} Using ${plain(wayRow(way, capabilities, blocks).title)} instead.`
          : null
      );
    }
    setPinned(wayId);
    // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the way on screen changes
  }, [readyToPrepare, wayId, pinned]);

  useEffect(() => {
    if (!readyToPrepare || !wayId || !wayUsage) {
      refreshing.current = null;
      return;
    }
    let active = true;
    const token = selection.current;
    const isCurrent = () => active && mounted.current && selection.current === token;
    // A review already on screen for this way stays while it is refreshed.
    setPrep((current) =>
      current.status === "done" && current.providerId === wayId && current.result.kind === "ready"
        ? current
        : { status: "preparing" }
    );
    void prepare(wayId, wayUsage, isCurrent)
      .then(async (result) => {
        if (result.kind === "sign-in") {
          // The host keeps one setup per service and returns it if one exists.
          // Positive: only while this preparation is current and the password is set.
          if (!isCurrent() || passwordMissingNow.current) throw new PreparationStopped();
          await send("/setups", {
            providerId: wayId,
            draftId: result.draft.draftId,
            actionId: result.action.id,
            expectedConfigurationRevision: result.draft.configuration.revision,
            usage: wayUsage,
          });
          const fresh = await request("/state");
          if (active && fresh.ok) setState(fresh.data as State);
        }
        return result;
      })
      .then((result) => {
        if (!active) return;
        refreshing.current = null;
        if (result.kind === "ready") {
          const before = shownReview.current;
          if (before && before.candidate.consentFactsDigest !== result.review.candidate.consentFactsDigest) {
            setChanged(changedFacts(before.candidate, result.review.candidate));
          }
          shownReview.current = result.review;
        }
        setPrep({ status: "done", providerId: wayId, result });
        setPrepError(null);
      })
      .catch((failure) => {
        if (!active) return;
        refreshing.current = null;
        setPrep({ status: "idle" });
        if (failure instanceof PreparationStopped) return;
        setPrepError(toDisplayError(failure, "action", wayLabel));
      });
    return () => {
      active = false;
    };
    // `send` only wraps `request`.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [readyToPrepare, wayId, wayUsage, prepRun, request]);

  // An expired review is replaced without a click.
  const readyReview = prep.status === "done" && prep.providerId === wayId && prep.result.kind === "ready" ? prep.result.review : null;
  useEffect(() => {
    if (!readyReview) return;
    const timer = setInterval(() => {
      if (!reviewExpired(readyReview, Date.now())) return;
      // One refresh per expired review, however long it takes.
      if (refreshing.current === readyReview.id) return;
      refreshing.current = readyReview.id;
      setPrepRun((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [readyReview]);

  // After Turn on again: turn on once the review is ready and shows the facts
  // the owner approved before. Different facts wait for a click.
  useEffect(() => {
    if (!readyReview || !againPending.current || busy) return;
    againPending.current = false;
    if (readyReview.candidate.consentFactsDigest === approvedDigest.current) {
      void turnOn(readyReview);
    } else {
      setChanged([]);
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a review becomes ready
  }, [readyReview, busy]);

  async function change(run: () => Promise<void>, kind: ActionKind = "turn-on") {
    actionEpoch.current += 1;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (failure) {
      setError(toDisplayError(failure, "action", wayLabel, kind));
    } finally {
      actionEpoch.current += 1;
      setBusy(false);
    }
  }
  // The same runner, told what the owner was doing, so a failure says so.
  const turnOff = (run: () => Promise<void>) => change(run, "turn-off");
  const checkIt = (run: () => Promise<void>) => change(run, "check");
  const edit = (run: () => Promise<void>) => change(run, "change");

  // Sends the approval for the review whose facts are on screen, then applies.
  // `shown` is the review the owner saw: its digest is what is approved. If the
  // host holds a newer review of the same facts, only its id is newer.
  async function turnOn(shown: Review) {
    const token = selection.current;
    const isCurrent = () => mounted.current && selection.current === token && wayIdNow.current === shown.candidate.providerId;
    await change(async () => {
      if (!isCurrent()) return;
      let target = shown;
      let refresh = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (refresh || reviewExpired(target, Date.now())) {
          // Stopped means the screen went away or the password is gone; the screen already says so.
          const fresh = await prepare(
            shown.candidate.providerId,
            wayUsage ?? "",
            isCurrent
          ).catch((failure) => {
            if (failure instanceof PreparationStopped) return null;
            throw failure;
          });
          if (!fresh || !isCurrent()) return;
          if (fresh.kind !== "ready") {
            setPrep({ status: "done", providerId: shown.candidate.providerId, result: fresh });
            return;
          }
          if (fresh.review.candidate.consentFactsDigest !== shown.candidate.consentFactsDigest) {
            shownReview.current = fresh.review;
            setChanged(changedFacts(shown.candidate, fresh.review.candidate));
            setPrep({ status: "done", providerId: fresh.review.candidate.providerId, result: fresh });
            return;
          }
          target = fresh.review;
        }
        if (!isCurrent()) return;
        requirePassword();
        try {
          const pending = await send<{ operationId: string }>("/operations", {
            reviewId: target.id,
            kind: "route",
            consentFactsDigest: shown.candidate.consentFactsDigest,
            acknowledgeDisconnect: true,
          });
          if (!isCurrent()) return;
          approvedDigest.current = shown.candidate.consentFactsDigest;
          setOperation({ ...pending, kind: "start", stage: "applying", recovery: null });
          setCancel(null);
          setChanged(null);
          shownReview.current = null;
          setPrep({ status: "idle" });
          return;
        } catch (failure) {
          if (!isCurrent()) return;
          const code = failure instanceof ReachabilityFailure ? failure.detail.code : null;
          if (!(code && staleReviewCodes.has(code)) || attempt === 1) throw failure;
          // The host no longer holds that review. Get a new one and compare.
          refresh = true;
        }
      }
    });
  }
  async function allow(draft: Draft, action: Action, input: { value?: string; secret?: string }) {
    const token = selection.current;
    await change(async () => {
      requirePassword();
      if (selection.current !== token) return;
      await runAction(send, draft, action, input);
      setPrepRun((n) => n + 1);
    });
  }
  function pickWay(providerId: string) {
    // The radios are disabled while a change is in flight; this is the same rule at the handler.
    if (mutationBlocked) return;
    selection.current += 1;
    setPinned(providerId);
    setSwitchNote(null);
    setDeclined(null);
    setChanged(null);
    shownReview.current = null;
    setPrepRun((n) => n + 1);
  }
  function chooseAnotherWay() {
    if (wayId) setDeclined(wayId);
    setShowOtherWays(true);
    setPrep({ status: "idle" });
  }
  async function stopOperation(current: Operation) {
    setCancel("stopping");
    await change(async () => {
      try {
        const route = await send<Route>(`/operations/${encodeURIComponent(current.operationId)}/reconcile`, {
          action: "stop",
          acknowledgeDisconnect: true,
        });
        if (route.cleanup.state === "confirmed") {
          setCancel(null);
          setOperation(null);
          setPrepRun((n) => n + 1);
        } else {
          setCancel("unconfirmed");
        }
      } catch (failure) {
        setCancel("unconfirmed");
        throw failure;
      }
    }, "turn-off");
  }
  // Renews the proof before its window ends, with no click and no status change.
  async function runRecheck(id: string, generation: number, key: string) {
    setRechecked((current) => new Set(current).add(key));
    setRechecking((current) => new Set(current).add(id));
    const fail = (code: string) => setRecheckFailure((current) => ({ ...current, [id]: code }));
    try {
      const result = await request(`/routes/${encodeURIComponent(id)}/check`, { generation });
      if (!result.ok) {
        fail(result.code);
        return;
      }
      const checked = result.data as Route;
      if (checked.verification.status !== "verified" || !checked.published) fail(publicError("verification_failed").code);
      // Same guard as a poll: a reply that an action or a newer poll has passed is dropped.
      const seq = ++loadSeq.current;
      const startedInEpoch = actionEpoch.current;
      const fresh = await request("/state");
      if (fresh.ok && mounted.current && seq >= appliedSeq.current && startedInEpoch === actionEpoch.current) {
        appliedSeq.current = seq;
        setState(fresh.data as State);
      }
    } catch {
      fail(publicError("service_unreachable").code);
    } finally {
      setRechecking((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }
  const recheckKey = recheckTarget && !rechecked.has(recheckTarget.key) ? recheckTarget.key : null;
  // When the browser first saw each proof window, on its own clock. The delay
  // counts from here, so a browser clock that differs from the server's changes
  // nothing.
  const proofSeenAt = useRef(new Map<string, number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: one timer per proof window, keyed by `recheckKey`
  useEffect(() => {
    if (!recheckTarget || recheckKey === null || busy) return;
    const { route, key, delay } = recheckTarget;
    const seen = proofSeenAt.current.get(key) ?? Date.now();
    proofSeenAt.current.set(key, seen);
    const timer = setTimeout(() => {
      void runRecheck(route.handle.id, route.handle.generation, key);
    }, Math.max(0, seen + delay - Date.now()));
    return () => clearTimeout(timer);
  }, [recheckKey, recheckTarget?.delay, busy, request]);

  // `accepted` runs only once the host has accepted the stop. A refused stop
  // leaves the route where it was, still needing the owner and still re-checked.
  async function stopRoute(route: Route, accepted: () => void) {
    await turnOff(async () => {
      const pending = await send<{ operationId: string }>(`/routes/${encodeURIComponent(route.handle.id)}/stop`, {
        generation: route.handle.generation,
        acknowledgeDisconnect: true,
      });
      accepted();
      setAcknowledged((current) => new Set(current).add(route.handle.id));
      setOperation({ ...pending, kind: "stop", stage: "applying", recovery: null });
    });
  }
  function turnOffRoute(route: Route) {
    return stopRoute(route, () => {
      setPreviousOrigin(null);
      againPending.current = false;
    });
  }
  // Turn off, then turn on again on the facts the owner already approved. If the
  // facts changed, the owner sees what changed and clicks again.
  function turnOnAgain(route: Route) {
    return stopRoute(route, () => {
      setPreviousOrigin(route.origin);
      againPending.current = approvedDigest.current !== null;
    });
  }
  // Same operation id: the host checks the route it already has and starts nothing new.
  async function retryOperation(current: Operation) {
    await checkIt(async () => {
      await send(`/operations/${encodeURIComponent(current.operationId)}/reconcile`, {
        action: "check",
        acknowledgeDisconnect: true,
      });
      const [operationResult, stateResult] = await Promise.all([
        request(`/operations/${encodeURIComponent(current.operationId)}`),
        request("/state"),
      ]);
      if (operationResult.ok) {
        setOperation({ ...(operationResult.data as Operation), kind: (operationResult.data as Operation).kind ?? current.kind });
      }
      if (stateResult.ok) setState(stateResult.data as State);
    });
  }

  // After it failed or after Cancel: Off and a fresh review, once the owner asks.
  function startOver() {
    setOperation(null);
    setCancel(null);
    setPrepRun((n) => n + 1);
  }

  // After the desktop restarts for a new password it reopens this card by its
  // fragment. Remember that once, then clear the fragment.
  const [returnedFromPassword] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#remote-access"
  );
  useEffect(() => {
    if (returnedFromPassword) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [returnedFromPassword]);
  async function setPassword() {
    // The native shell reads this address before it restarts, so the card is
    // reopened afterwards.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#remote-access`);
    await change(async () => {
      const result = await requestOwnerPasswordWindowAction();
      if (!result.ok) throw new ReachabilityFailure(publicError("owner_password_required", result.message, "change"));
    }, "change");
  }
  // A route turned off and replaced is history: the newest one is the card.
  const settledOff = (route: Route) => route.state === "released" && route.cleanup.state === "confirmed";
  const visibleRoutes = state.routes.filter(
    (route) => !(settledOff(route) && state.routes.some((other) => other !== route && !settledOff(other)))
  );
  // What the buttons on an error do. None of them reload the page.
  const refresh = () => {
    setError(null);
    setPrepError(null);
    void loadRef.current?.();
    setPrepRun((n) => n + 1);
  };
  const recover: Recover = {
    request,
    onTryAgain: refresh,
    onRefresh: refresh,
    onTryAnotherWay: () => {
      setError(null);
      setPrepError(null);
      chooseAnotherWay();
    },
  };
  const hostReasonShown = !host.known && host.reason !== "loading";
  const serviceLabel = wayLabel ?? "the service";
  const done = prep.status === "done" && prep.providerId === wayId ? prep.result : null;
  return (
    <DiagnosticsContext.Provider value={appVersion === undefined ? {} : { appVersion }}>
    <section aria-label="Remote access" className="grid gap-6">
      <div>
        <h2 className="pdpp-heading">Remote access</h2>
      </div>
      {passwordMissing ? (
        <div className="grid gap-2">
          <h3 className="pdpp-label">Step 1: Set a password</h3>
          <p>
            Once remote access is on, anyone with your address can reach the sign-in page. Your password is the only
            thing stopping them, so choose one first.
          </p>
          <button type="button" disabled={busy || stale} onClick={() => void setPassword()}>
            Set password
          </button>
        </div>
      ) : returnedFromPassword ? (
        <p role="status">Password saved ✓ Step 2: turn on.</p>
      ) : null}
      <RecoveryContext.Provider value={recover}>
        {error ? <ErrorNotice error={error} /> : null}
        {prepError ? <ErrorNotice error={prepError} /> : null}
      </RecoveryContext.Provider>
      {stale ? <p role="status">Can't reach DataConnect's background service. Changes are paused.</p> : null}
      {hostReasonShown && !error ? <p role="status">{ERROR_MESSAGES.host_supervisor_unavailable}</p> : null}
      {state.lifecycle?.cleanup === "unconfirmed" ? (
        <p role="status">{CLEANUP_UNCONFIRMED}</p>
      ) : null}
      {inventory ? null : (
        <p role="status">{stale ? "Remote access can't start on this computer." : "Checking this computer…"}</p>
      )}
      {idle && state.routes.length === 0 && !operation ? (
        <p role="status">Off · Only this computer can open DataConnect.</p>
      ) : null}
      {idle && !passwordMissing ? (
        <section aria-label="Turn on remote access" className="grid gap-4">
          <h3 className="pdpp-label">Step 2 of 2 · Turn on</h3>
          {inventory && recommended ? (
            <RecommendedWay
              checked={wayId === recommended.providerId}
              disabled={mutationBlocked}
              onPick={pickWay}
              row={wayRow(recommended, capabilities, blocks)}
            />
          ) : null}
          {switchNote ? <p role="status">{switchNote}</p> : null}
          {prep.status === "preparing" ? <p role="status">Checking this computer…</p> : null}
          {done?.kind === "allow" && declined !== wayId ? (
            <AllowCard
              action={done.action}
              busy={mutationBlocked}
              draft={done.draft}
              onAllow={(action, input) => void allow(done.draft, action, input)}
              onOther={chooseAnotherWay}
            />
          ) : null}
          {done?.kind === "ready" ? (
            <TurnOnCard
              busy={mutationBlocked}
              changed={changed}
              key={done.review.id}
              onTurnOn={(review) => void turnOn(review)}
              review={done.review}
            />
          ) : null}
          {wayId && wayUsage === null ? <p role="status">Remote access can't start with this way on this computer.</p> : null}
          <button aria-expanded={showOtherWays} disabled={busy} onClick={() => setShowOtherWays((open) => !open)} type="button">
            Other ways
          </button>
          {showOtherWays && inventory ? (
            <OtherWays
              blocks={blocks}
              capabilities={capabilities}
              disabled={mutationBlocked}
              inventory={inventory}
              onPick={pickWay}
              pickedId={wayId}
              recommendedId={recommended?.providerId ?? null}
            />
          ) : null}
        </section>
      ) : null}
      {reservations.map((reservation) => (
        <ProviderSetup
          acknowledgeDisconnect
          disabled={mutationBlocked || passwordMissing}
          isCurrentWay={() => wayIdNow.current === reservation.providerId}
          key={reservation.operationId}
          pollTick={setupTick}
          reservation={reservation}
          request={request}
          onReadiness={() => undefined}
          onChange={async (view, mutation) => {
            // A finished or changed setup moves the chain on.
            if (view.scope.providerId === "tailscale-funnel") {
              const policy = view.state === "blocked" && view.nextAction?.id === funnelPolicyActionId;
              setBlocks((current) => {
                if (!policy) {
                  if (!("tailscale-funnel" in current)) return current;
                  const { "tailscale-funnel": _gone, ...rest } = current;
                  return rest;
                }
                return { ...current, "tailscale-funnel": funnelPolicyBlock(view.nextAction?.href) };
              });
            }
            const mark = `${view.operationId}:${view.revision}:${view.state}`;
            if ((mutation || view.state === "complete") && seenSetup.current !== mark) {
              seenSetup.current = mark;
              setPrepRun((n) => n + 1);
            }
          }}
        />
      ))}
      {operation && operation.kind === "stop" && outcome === "turning-on" ? (
        <p role="status">Turning off…</p>
      ) : null}
      {operation && operation.kind !== "stop" && cancel === "stopping" ? <p role="status">Turning off…</p> : null}
      {operation && operation.kind !== "stop" && cancel === null && outcome === "turning-on" ? (
        <TurningOnChecklist
          busy={busy}
          onCancel={() => void stopOperation(operation)}
          service={serviceLabel}
          step={checklistStep(state.lifecycle?.phase ?? null)}
        />
      ) : null}
      {operation && (cancel === "unconfirmed" || (cancel === null && outcome === "needs-action")) ? (
        <section aria-label="Needs your action" className="grid gap-3">
          <h3 className="pdpp-label">Needs your action</h3>
          <p role="status">
            {cancel === "unconfirmed"
              ? "Couldn't confirm remote access is off. This address may still work."
              : "We lost track of the address. It may still be on."}
          </p>
          {cancel === null && operation.failureCode ? <p>{publicError(operation.failureCode).message}</p> : null}
          {cancel === null && operation.recovery ? <p>{publicError(operation.recovery.reason).message}</p> : null}
          <button
            disabled={busy || (cancel === null && operation.recovery !== null && !operation.recovery.available)}
            onClick={() => void stopOperation(operation)}
            type="button"
          >
            {operation.stage === "unknown-possibly-live" && cancel === null ? "Turn off" : "Check and turn off"}
          </button>
          {cancel === null && operation.recovery?.available ? (
            <button disabled={busy} onClick={() => void retryOperation(operation)} type="button">
              Try again
            </button>
          ) : null}
          {operation.failureCode || operation.recovery ? (
            <Diagnostics>
              {operation.failureCode ? <p>Code: {operation.failureCode}</p> : null}
              {operation.recovery ? <p>Recovery: {operation.recovery.reason}</p> : null}
            </Diagnostics>
          ) : null}
        </section>
      ) : null}
      {operation && operation.kind !== "stop" && cancel === null && outcome === "did-not-turn-on" ? (
        <section aria-label="Did not turn on" className="grid gap-3">
          <h3 className="pdpp-label">Remote access did not turn on</h3>
          {operation.failureCode ? <p role="status">{publicError(operation.failureCode).message}</p> : null}
          <button disabled={busy} onClick={startOver} type="button">
            Try again
          </button>
          <Diagnostics>{operation.failureCode ? <p>Code: {operation.failureCode}</p> : null}</Diagnostics>
        </section>
      ) : null}
      {runtimeReview ? (
        <RuntimeRouteConsentCard
          busy={busy}
          onApprove={(approval) =>
            void edit(async () => {
              await send(`/routes/${encodeURIComponent(runtimeReview.routeId)}/approve`, {
                generation: runtimeReview.generation,
                ...approval,
              });
              setRuntimeReview(null);
            })
          }
          review={runtimeReview.snapshot}
        />
      ) : null}
      <section aria-label="Your address" className="grid gap-4">
        {visibleRoutes.map((route) => {
          const unsupportedRefresh = unsupportedOf(route);
          const phase = phaseOf(route);
          const attention = attentionOf(route);
          const headline = headlineOf(route);
          const sentence = routeSentence(route, headline);
          const now = Date.now();
          const { shown: knownFacts, unknown: unknownFacts } = splitFacts(route.facts);
          const details = (
            <Diagnostics>
              <p className="break-words">
                Requested target:{" "}
                {route.hostConfiguration.target.known
                  ? route.hostConfiguration.target.value
                  : `Unknown: ${route.hostConfiguration.target.reason}`}
              </p>
              <p className="break-words">
                Observed binding ({route.binding.authority}):{" "}
                {route.binding.target.known ? route.binding.target.value : `Unknown: ${route.binding.target.reason}`}
              </p>
              <p>
                {state.lifecycle?.stopRequested && state.lifecycle.confinement.known && state.lifecycle.confinement.value
                  ? "Stopped locally"
                  : "Local confinement not observed"}{" "}
                · Cleanup: {route.cleanup.state}
              </p>
              <p>
                Lifecycle: {phase ?? "none"} · route{" "}
                {route.routeState}
              </p>
              <ConsentFacts facts={knownFacts} providerId={wayId} />
              <UnknownFactsCount count={unknownFacts} service={serviceLabel} />
            </Diagnostics>
          );
          const extras = (
            <>
              {route.binding.remedy ? (
                <div className="grid gap-2">
                  <h4 className="pdpp-label">{plain(route.binding.remedy.label)}</h4>
                  <p className="pdpp-caption whitespace-pre-wrap break-words">
                    {route.binding.remedy.instructions ?? route.binding.remedy.help ?? route.binding.remedy.disclosure.text}
                  </p>
                </div>
              ) : null}
              {route.cleanup.nextAction ? (
                <p className="pdpp-caption whitespace-pre-wrap break-words">
                  {route.cleanup.nextAction.instructions ?? plain(route.cleanup.nextAction.label)}
                </p>
              ) : null}
            </>
          );
          if (headline === "On" && route.cleanup.state !== "confirmed") {
            return (
              <div className="grid gap-3 rounded-lg border p-4" key={route.handle.id}>
                <OnCard
                  addressChanged={previousOrigin !== null && route.origin !== null && route.origin !== previousOrigin}
                  busy={busy}
                  now={now}
                  onTurnOff={() => void turnOffRoute(route)}
                  route={route}
                  synthetic={state.evidenceSource === "synthetic"}
                >
                  {extras}
                  {details}
                </OnCard>
              </div>
            );
          }
          return (
          <div className="grid gap-3 rounded-lg border p-4" key={route.handle.id}>
            <h3 className="pdpp-label">{headline}</h3>
            {sentence ? <p role="status">{sentence}</p> : null}
            {attention ? <p role="status">{attentionSentence(attention, route, serviceLabel)}</p> : null}
            {unsupportedRefresh ? <p role="status">{ERROR_MESSAGES.proof_refresh_unsupported}</p> : null}
            <p className="pdpp-caption break-words">Your address: {route.origin ?? "Not available yet"}</p>
            <p className="pdpp-caption">
              {proofLine(route, now, { synthetic: state.evidenceSource === "synthetic" })}
            </p>
            {extras}
            {route.cleanup.state !== "confirmed" || attention ? <div className="flex flex-wrap gap-3">
              {headline === "Needs your action" && route.cleanup.state !== "unconfirmed" ? (
                <button disabled={busy} onClick={() => void turnOnAgain(route)} type="button">
                  {unsupportedRefresh ? "Turn off and on" : "Turn on again"}
                </button>
              ) : null}
              {state.lifecycle?.phase === "review" && !unsupportedRefresh && !attention ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void edit(async () => {
                      const snapshot = await send<ReturnType<typeof projectRuntimeReview>>(
                        `/routes/${encodeURIComponent(route.handle.id)}/review`,
                        { generation: route.handle.generation }
                      );
                      setRuntimeReview({ routeId: route.handle.id, generation: route.handle.generation, snapshot });
                    })
                  }
                >
                  Review changes
                </button>
              ) : null}
              {!state.lifecycle?.stopRequested && !unsupportedRefresh && !attention ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void checkIt(async () => {
                      await send(`/routes/${encodeURIComponent(route.handle.id)}/check`, {
                        generation: route.handle.generation,
                      });
                    })
                  }
                >
                  Check again
                </button>
              ) : null}
              <button disabled={busy} onClick={() => void turnOffRoute(route)}>
                {route.cleanup.state === "unconfirmed" ? "Try again" : "Turn off"}
              </button>
            </div> : null}
            {details}
          </div>
          );
        })}
      </section>
      <Diagnostics>
        <h3 className="pdpp-label">This computer</h3>
        {Object.entries(capabilities).map(([id, observation]) => (
          <p key={id}>
            {id}: {observation.known ? String(observation.value) : `Unknown: ${observation.reason}`}
          </p>
        ))}
        {host.known ? (
          <>
            <p>
              Password:{" "}
              {host.value.password.known
                ? host.value.password.value
                  ? "Set"
                  : "Not set"
                : `Unknown: ${host.value.password.reason}`}
            </p>
            <p className="break-words">
              Target: {host.value.target.known ? host.value.target.value : `Unknown: ${host.value.target.reason}`}
            </p>
            <label>
              Port
              <input
                inputMode="numeric"
                onChange={(event) => setPort(event.target.value)}
                placeholder={host.value.port.known ? String(host.value.port.value ?? "Unpinned") : "Unknown"}
                value={port}
              />
            </label>
            <button
              disabled={mutationBlocked}
              onClick={() =>
                void edit(async () => {
                  const value = port.trim() === "" ? null : Number(port);
                  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 65_535)) {
                    throw new ReachabilityFailure({ code: "invalid_input", message: "Enter a port between 1 and 65535." });
                  }
                  const updated = await send<HostSettings>("/host-settings", {
                    expectedRevision: host.value.revision,
                    mode: host.value.mode,
                    port: value,
                    acknowledgeDisconnect: true,
                  });
                  setHost({ known: true, value: updated });
                })
              }
            >
              Save port
            </button>
          </>
        ) : (
          <p>Host settings unavailable: {host.reason}.</p>
        )}
        {inventory?.providers.map((item) => (
          <div key={`${item.providerId}-${item.reach}`}>
            <p>
              {item.label} · {item.providerId} · {item.reach} · {item.transport}
            </p>
            {Object.entries(item.availability).map(([kind, available]) => (
              <p key={kind}>
                {kind}: {available.state}
                {available.reason ? ` — ${available.reason}` : ""}
              </p>
            ))}
            {item.prerequisites.map((prerequisite) => (
              <p key={prerequisite.id}>
                {prerequisite.id}: {prerequisite.state} ·{" "}
                {prerequisite.version.known ? prerequisite.version.value : prerequisite.version.reason} ·{" "}
                {prerequisite.observedAt}
              </p>
            ))}
          </div>
        ))}
      </Diagnostics>
    </section>
    </DiagnosticsContext.Provider>
  );
}
