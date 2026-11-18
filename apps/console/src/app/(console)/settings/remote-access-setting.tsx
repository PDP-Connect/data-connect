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
import { proofLine, routeHeadline, routeSentence } from "./route-display.ts";
import {
  type DisplayError,
  Diagnostics,
  DiagnosticsContext,
  ErrorNotice,
  ReachabilityFailure,
  toDisplayError,
} from "./diagnostics.tsx";
import { formatLocalTime, plain } from "./plain-text.ts";
import { type ActionKind, ERROR_MESSAGES, publicError } from "./reachability-errors.ts";
import { ConsentFacts, RuntimeRouteConsentCard } from "./reachability-consent.tsx";
import {
  type Action,
  type Draft,
  type Prepared,
  type Review,
  changedFacts,
  defaultProvider,
  operationOutcome,
  pickUsage,
  prepareTurnOn,
  reviewExpired,
  runAction,
  staleReviewCodes,
} from "./prepare-remote-access.ts";
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

// How a way reaches people, in the owner's words. Unlisted values pass through `plain`.
const reachLabels: Record<string, string> = { lan: "Same Wi-Fi only" };
const kindLabels: Record<string, string> = {
  session: "Temporary",
  durable: "Lasting",
  attached: "While DataConnect runs",
};
const availabilityLabels: Record<string, string> = {
  "action-required": "Needs setup",
  "detect-only": "Not available yet",
  unsupported: "Not supported",
};
const kindLabel = (kind: string) => kindLabels[kind] ?? plain(kind.charAt(0).toUpperCase() + kind.slice(1));

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
  // The way the owner picked under Other ways. Until then the default one is used.
  const [chosen, setChosen] = useState<string | null>(null);
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
  const reservations = setupCards(state.services);
  // Bumped when an action starts and when it ends. A poll started in an earlier
  // epoch is dropped. `loadSeq` and `appliedSeq` order the polls themselves.
  const actionEpoch = useRef(0);
  const loadSeq = useRef(0);
  const appliedSeq = useRef(0);
  const seenSetup = useRef<string | null>(null);

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
      if (catalogResult.ok) {
        setInventory(catalogResult.data as Inventory);
        setStale(false);
      } else {
        setStale(true);
        setError((current) =>
          current?.source === "action" || (current?.source === "load" && current.code === catalogResult.code)
            ? current
            : toDisplayError(new ReachabilityFailure(catalogResult), "load")
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
    // Setups an older console kept in the browser move to the host first, and
    // polling starts only after that finishes.
    void migrateLegacySetupReservations(request)
      .catch(() => undefined)
      .then(async () => {
        if (!active) {
          return;
        }
        await load();
        if (active) {
          timer = setInterval(() => {
            void load();
          }, 3000);
        }
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

  const providers = [...(inventory?.providers ?? [])].sort(
    (a, b) =>
      Number(b.reach === "lan") - Number(a.reach === "lan") ||
      a.label.localeCompare(b.label) ||
      a.providerId.localeCompare(b.providerId)
  );
  const way = inventory
    ? ((chosen ? inventory.providers.find((item) => item.providerId === chosen) : undefined) ??
      defaultProvider(inventory, capabilities))
    : undefined;
  const wayUsage = way ? pickUsage(way, capabilities) : null;
  const wayId = way?.providerId ?? null;
  const wayLabel = way ? plain(way.label) : undefined;

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
  const phaseOf = (route: Route) => (state.lifecycle?.handle?.id === route.handle.id ? (state.lifecycle?.phase ?? null) : null);
  const routesOff = state.routes.every(
    (route) => routeHeadline(route, phaseOf(route), state.reasons[route.handle.id] === "proof_refresh_unsupported") === "Off"
  );
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

  useEffect(() => {
    if (!readyToPrepare || !wayId || !wayUsage) {
      return;
    }
    let active = true;
    // A review already on screen for this way stays while it is refreshed.
    setPrep((current) =>
      current.status === "done" && current.providerId === wayId && current.result.kind === "ready"
        ? current
        : { status: "preparing" }
    );
    void prepareTurnOn(request, { providerId: wayId, usage: wayUsage }, { mayRunActions: () => !passwordMissingNow.current })
      .then(async (result) => {
        if (result.kind === "sign-in") {
          // The host keeps one setup per service and returns it if one exists.
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
        setPrep({ status: "idle" });
        setPrepError(toDisplayError(failure, "action", wayLabel));
      });
    return () => {
      active = false;
    };
    // `send` only wraps `request`.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  }, [readyToPrepare, wayId, wayUsage, prepRun, request]);

  // An expired review is replaced without a click.
  const readyReview = prep.status === "done" && prep.result.kind === "ready" ? prep.result.review : null;
  useEffect(() => {
    if (!readyReview) return;
    const timer = setInterval(() => {
      if (reviewExpired(readyReview, Date.now())) setPrepRun((n) => n + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [readyReview]);

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
    await change(async () => {
      let target = shown;
      let refresh = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (refresh || reviewExpired(target, Date.now())) {
          const fresh = await prepareTurnOn(request, { providerId: shown.candidate.providerId, usage: wayUsage ?? "" }, { mayRunActions: () => !passwordMissingNow.current });
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
        requirePassword();
        try {
          const pending = await send<{ operationId: string }>("/operations", {
            reviewId: target.id,
            kind: "route",
            consentFactsDigest: shown.candidate.consentFactsDigest,
            acknowledgeDisconnect: true,
          });
          setOperation({ ...pending, kind: "start", stage: "applying", recovery: null });
          setCancel(null);
          setChanged(null);
          shownReview.current = null;
          setPrep({ status: "idle" });
          return;
        } catch (failure) {
          const code = failure instanceof ReachabilityFailure ? failure.detail.code : null;
          if (!(code && staleReviewCodes.has(code)) || attempt === 1) throw failure;
          // The host no longer holds that review. Get a new one and compare.
          refresh = true;
        }
      }
    });
  }
  async function allow(draft: Draft, action: Action, input: { value?: string; secret?: string }) {
    await change(async () => {
      requirePassword();
      await runAction(send, draft, action, input);
      setPrepRun((n) => n + 1);
    });
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
  const hostReasonShown = !host.known && host.reason !== "loading";
  const serviceLabel = wayLabel ?? "the service";
  const done = prep.status === "done" ? prep.result : null;
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
      {error ? <ErrorNotice error={error} /> : null}
      {prepError ? (
        <>
          <ErrorNotice error={prepError} />
          <button disabled={busy} onClick={() => setPrepRun((n) => n + 1)} type="button">
            Try again
          </button>
        </>
      ) : null}
      {stale ? <p role="status">Can't reach DataConnect's background service. Changes are paused.</p> : null}
      {hostReasonShown ? <p role="status">{ERROR_MESSAGES.host_supervisor_unavailable}</p> : null}
      {state.lifecycle?.cleanup === "unconfirmed" ? (
        <p role="status">We couldn't confirm your address is closed. It may still work.</p>
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
          {showOtherWays ? (
            <fieldset className="grid gap-3" disabled={mutationBlocked}>
              <legend className="pdpp-label">Other ways</legend>
              {providers.map((item) => (
                <label className="grid gap-1 rounded-lg border p-3" key={`${item.providerId}-${item.reach}`}>
                  <span>
                    <input
                      checked={wayId === item.providerId}
                      disabled={pickUsage(item, capabilities) === null}
                      name="way"
                      onChange={() => {
                        setChosen(item.providerId);
                        setDeclined(null);
                        setChanged(null);
                        shownReview.current = null;
                        setPrepRun((n) => n + 1);
                      }}
                      type="radio"
                    />{" "}
                    {plain(item.label)}
                  </span>
                  <span className="pdpp-caption text-muted-foreground">{reachLabels[item.reach] ?? plain(item.reach)}</span>
                  {Object.entries(item.availability)
                    .filter(([, available]) => available.state !== "available")
                    .map(([kind, available]) => (
                      <span className="pdpp-caption" key={kind}>
                        {kindLabel(kind)}: {availabilityLabels[available.state] ?? plain(available.state)}
                        {available.reason && available.state !== "detect-only" ? ` — ${plain(available.reason)}` : ""}
                      </span>
                    ))}
                </label>
              ))}
            </fieldset>
          ) : null}
        </section>
      ) : null}
      {reservations.map((reservation) => (
        <ProviderSetup
          acknowledgeDisconnect
          disabled={mutationBlocked || passwordMissing}
          key={reservation.operationId}
          reservation={reservation}
          request={request}
          onReadiness={() => undefined}
          onChange={async (view, mutation) => {
            // A finished or changed setup moves the chain on.
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
            Check and turn off
          </button>
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
        {state.routes.map((route) => {
          const unsupportedRefresh = state.reasons[route.handle.id] === "proof_refresh_unsupported";
          const phase = state.lifecycle?.handle?.id === route.handle.id ? (state.lifecycle?.phase ?? null) : null;
          const headline = routeHeadline(route, phase, unsupportedRefresh);
          const sentence = routeSentence(route, headline);
          return (
          <div className="grid gap-3 rounded-lg border p-4" key={route.handle.id}>
            <h3 className="pdpp-label">{headline}</h3>
            {sentence ? <p role="status">{sentence}</p> : null}
            {unsupportedRefresh ? <p role="status">{ERROR_MESSAGES.proof_refresh_unsupported}</p> : null}
            <p className="pdpp-caption break-words">Your address: {route.origin ?? "Not available yet"}</p>
            <p className="pdpp-caption">
              {proofLine(route, Date.now(), { synthetic: state.evidenceSource === "synthetic" })}
            </p>
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
            {route.cleanup.state !== "confirmed" ? <div className="flex flex-wrap gap-3">
              {state.lifecycle?.phase === "review" && !unsupportedRefresh ? (
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
              {!state.lifecycle?.stopRequested && !unsupportedRefresh ? (
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
              <button
                disabled={busy}
                onClick={() =>
                  void turnOff(async () => {
                    const pending = await send<{ operationId: string }>(
                      `/routes/${encodeURIComponent(route.handle.id)}/stop`,
                      { generation: route.handle.generation, acknowledgeDisconnect: true }
                    );
                    setOperation({ ...pending, kind: "stop", stage: "applying", recovery: null });
                  })
                }
              >
                {route.cleanup.state === "unconfirmed" ? "Try turning off again" : "Turn off"}
              </button>
            </div> : null}
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
              <ConsentFacts facts={route.facts} />
            </Diagnostics>
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
