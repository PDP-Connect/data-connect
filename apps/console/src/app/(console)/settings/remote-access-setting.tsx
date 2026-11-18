"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import type { HostSettings } from "pdpp-reference-implementation/reachability-host-settings";
import type {
  projectCandidate,
  projectConfiguration,
  projectDraft,
  projectInventory,
  projectRoute,
  projectRuntimeReview,
} from "pdpp-reference-implementation/reachability-projection";
import { useCallback, useEffect, useRef, useState } from "react";
import { migrateLegacySetupReservations } from "../../../lib/legacy-setup-reservations.ts";
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
import { ERROR_MESSAGES, publicError } from "./reachability-errors.ts";
import { ConsentFacts, RouteConsentCard, RuntimeRouteConsentCard, SetupApprovalCard } from "./reachability-consent.tsx";

type Draft = ReturnType<typeof projectDraft>;
function choiceKey(
  provider: { providerId: string; reach: string; configuration: { revision: string } },
  usage: string | null
): string {
  return JSON.stringify([provider.providerId, provider.reach, usage, provider.configuration.revision]);
}
type Inventory = ReturnType<typeof projectInventory>;
type Route = ReturnType<typeof projectRoute>;
type Operation = {
  failureCode?: string | null;
  operationId: string;
  stage: string;
  recovery: { available: boolean; reason: string } | null;
};
type Review = { id: string; kind: "route"; candidate: ReturnType<typeof projectCandidate> };
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
  starting: boolean;
};

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
  const [selected, setSelected] = useState<string | null>(null);
  const [draftProviderId, setDraftProviderId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [runtimeReview, setRuntimeReview] = useState<{
    routeId: string;
    generation: number;
    snapshot: ReturnType<typeof projectRuntimeReview>;
  } | null>(null);
  const [committed, setCommitted] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [usage, setUsage] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const reservations = setupCards(state.services);
  const draftHydrated = useRef(false);
  const [setupReadiness, setSetupReadiness] = useState<Record<string, string | null>>({});
  const onSetupReadiness = useCallback((draftId: string, revision: string | null) => {
    setSetupReadiness((current) => ({ ...current, [draftId]: revision }));
  }, []);

  async function send<T>(path: string, input?: Record<string, unknown>): Promise<T> {
    const result = await request(path, input);
    if (!result.ok) {
      throw new ReachabilityFailure(result);
    }
    return result.data as T;
  }
  useEffect(() => {
    let active = true;
    const load = async () => {
      const [catalogResult, stateResult, hostResult, capabilityResult] = await Promise.all([
        request("/catalog"),
        request("/state"),
        request("/host-settings"),
        request("/host-capabilities"),
      ]);
      if (!active) {
        return;
      }
      if (catalogResult.ok) {
        setInventory(catalogResult.data as Inventory);
        setStale(false);
      } else {
        setStale(true);
        setError((current) =>
          current?.source === "load" && current.code === catalogResult.code
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
        if (!draftHydrated.current) {
          // The host holds the draft. Pick it up once, after a reload or restart.
          draftHydrated.current = true;
          const saved = next.services?.find((item) => item.draftId && !item.committed);
          if (saved?.draftId) {
            const result = await request(
              `/drafts/${encodeURIComponent(saved.draftId)}?providerId=${encodeURIComponent(saved.providerId)}`
            );
            if (!active) {
              return;
            }
            if (result.ok) {
              setDraft(result.data as Draft);
              setDraftProviderId(saved.providerId);
              setUsage(saved.usage);
              setCommitted(false);
            } else {
              setError(toDisplayError(new ReachabilityFailure(result), "load"));
            }
          }
        }
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
    // Setups an older console kept in the browser move to the host first.
    void migrateLegacySetupReservations(request)
      .catch(() => undefined)
      .then(() => load());
    const timer = setInterval(() => {
      void load();
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
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
          setOperation(result.data as Operation);
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

  const provider = inventory?.providers.find((item) => choiceKey(item, usage) === selected);
  const providers = [...(inventory?.providers ?? [])].sort(
    (a, b) =>
      Number(b.reach === "lan") - Number(a.reach === "lan") ||
      a.label.localeCompare(b.label) ||
      a.providerId.localeCompare(b.providerId)
  );
  async function change(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (failure) {
      setError(toDisplayError(failure, "action", provider ? plain(provider.label) : undefined));
    } finally {
      setBusy(false);
      setValues({});
    }
  }
  async function openDraft() {
    if (!provider) {
      return;
    }
    const next = await send<Draft>("/drafts", {
      providerId: provider.providerId,
      expectedRevision: provider.configuration.revision,
      ...(usage === null ? {} : { usage }),
    });
    setDraft(next);
    setDraftProviderId(provider.providerId);
    setCommitted(false);
    setReview(null);
  }
  async function editApplied() {
    if (!draft || !draftProviderId) return;
    const nextInventory = await send<Inventory>("/catalog");
    const matches = nextInventory.providers.filter(item => item.providerId === draftProviderId);
    if (matches.length !== 1 || !matches[0]) throw new ReachabilityFailure(publicError("configuration_stale"));
    const current = matches[0];
    await send(`/drafts/${encodeURIComponent(draft.draftId)}/discard`, {});
    const next = await send<Draft>("/drafts", {
      providerId: current.providerId,
      expectedRevision: current.configuration.revision,
      ...(usage === null ? {} : { usage }),
    });
    setInventory(nextInventory); setSelected(choiceKey(current, usage));
    setDraft(next); setCommitted(false); setReview(null);
  }
  async function setup(action: Draft["configuration"]["actions"][number], approval: unknown) {
    if (!draft) {
      return;
    }
    const field = draft.configuration.inputRequirements.find((item) => item.actionId === action.id);
    const value = field ? values[field.id] : undefined;
    const configuration = await send<ReturnType<typeof projectConfiguration>>(
      `/drafts/${encodeURIComponent(draft.draftId)}/${action.kind === "clear-input" ? "clear" : "actions"}/${encodeURIComponent(action.id)}`,
      {
        expectedRevision: draft.configuration.revision,
        approval,
        ...(value === undefined ? {} : field?.secret ? { secret: value } : { value }),
      }
    );
    setDraft({ ...draft, configuration });
    setCommitted(false);
    setReview(null);
  }
  async function reloadDraft() {
    if (!(draft && draftProviderId)) {
      return;
    }
    const next = await send<Draft>(
      `/drafts/${encodeURIComponent(draft.draftId)}?providerId=${encodeURIComponent(draftProviderId)}`
    );
    setDraft(next);
    setCommitted(false);
    setReview(null);
  }
  const mutationBlocked = busy || stale || state.starting;
  const setupAction = draft?.configuration.actions.find((action) => action.step);
  const hasReservation = reservations.some((item) => item.draftId === draft?.draftId);
  const setupNeedsInput = draft && (setupAction || hasReservation) && setupReadiness[draft.draftId] !== draft.configuration.revision;
  async function reserveSetup() {
    if (!draft || !draftProviderId || !usage || !setupAction || hasReservation) return;
    try {
      // The host keeps one setup per service and returns it if one exists.
      await send("/setups", {
        providerId: draftProviderId,
        draftId: draft.draftId,
        actionId: setupAction.id,
        expectedConfigurationRevision: draft.configuration.revision,
        usage,
      });
    } finally {
      const fresh = await request("/state");
      if (fresh.ok) setState(fresh.data as State);
    }
  }
  const hostReasonShown = !host.known && host.reason !== "loading";
  const newestObservation = inventory?.providers
    .flatMap((item) => item.prerequisites.map((prerequisite) => prerequisite.observedAt))
    .filter((value): value is string => typeof value === "string")
    .sort()
    .at(-1);
  return (
    <DiagnosticsContext.Provider value={appVersion === undefined ? {} : { appVersion }}>
    <section aria-label="Remote access" className="grid gap-6">
      <div>
        <h2 className="pdpp-heading">Remote access</h2>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      {stale ? <p role="status">Can't reach DataConnect's background service. Changes are paused.</p> : null}
      {hostReasonShown ? <p role="status">{ERROR_MESSAGES.host_supervisor_unavailable}</p> : null}
      {state.lifecycle?.cleanup === "unconfirmed" ? (
        <p role="status">We couldn't confirm your address is closed. It may still work.</p>
      ) : null}
      <fieldset className="grid gap-3" disabled={mutationBlocked || draft !== null}>
        <legend className="pdpp-label">Ways to connect</legend>
        <label>
          <input
            checked={selected === ""}
            name="way"
            onChange={() => {
              setSelected("");
              setUsage(null);
            }}
            type="radio"
          />{" "}
          Off · Only this computer can open DataConnect.
        </label>
        {providers.map((item) => (
          <label className="grid gap-1 rounded-lg border p-3" key={choiceKey(item, usage)}>
            <span>
              <input
                checked={selected === choiceKey(item, usage)}
                name="way"
                onChange={() => {
                  setSelected(choiceKey(item, null));
                  setUsage(null);
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
      {selected === "" ? (
        <button
          disabled={mutationBlocked || !host.known || !host.value.port.known}
          onClick={() =>
            void change(async () => {
              if (!(host.known && host.value.port.known)) {
                return;
              }
              const updated = await send<HostSettings>("/host-settings", {
                expectedRevision: host.value.revision,
                mode: "off",
                port: host.value.port.value,
                acknowledgeDisconnect: acknowledged,
              });
              setHost({ known: true, value: updated });
            })
          }
        >
          Turn off
        </button>
      ) : null}
      {inventory ? null : (
        <p role="status">{stale ? "Remote access can't start on this computer." : "Checking this computer…"}</p>
      )}
      {provider ? (
        <>
          <section aria-label="Prerequisites" className="grid gap-3">
            <h3 className="pdpp-label">Before turning on</h3>
            {provider.prerequisites.map((item) => (
              <div key={item.id}>
                <p>
                  {plain(item.label)}: {plain(item.state)}
                </p>
                {item.remedy ? (
                  <p className="pdpp-caption whitespace-pre-wrap break-words">
                    {plain(item.remedy.instructions ?? item.remedy.label)}
                  </p>
                ) : (
                  <p className="pdpp-caption">No automatic fix is available.</p>
                )}
              </div>
            ))}
            {newestObservation ? (
              <p className="pdpp-caption text-muted-foreground">
                Checked this computer · {formatLocalTime(newestObservation)}
              </p>
            ) : null}
          </section>
          <fieldset disabled={mutationBlocked}>
            <legend className="pdpp-label">How long</legend>
            {Object.entries(provider.availability).map(([kind, available]) => (
              <label className="mr-4" key={kind}>
                <input
                  checked={usage === kind}
                  disabled={available.state === "unsupported" || available.state === "detect-only" ||
                    (kind === "durable" && capabilities["runtime.durable"]?.value === false)}
                  name="usage"
                  onChange={() => {
                    setUsage(kind);
                    setSelected(choiceKey(provider, kind));
                  }}
                  type="radio"
                />{" "}
                {kindLabel(kind)}
              </label>
            ))}
          </fieldset>
          {draft ? null : (
            <button disabled={mutationBlocked || !usage} onClick={() => void change(openDraft)}>
              Continue setup
            </button>
          )}
        </>
      ) : null}
      {draft ? (
        <section aria-label="Setup" className="grid gap-4">
          <h3 className="pdpp-label">Setup details</h3>
          <button disabled={busy} onClick={() => void change(reloadDraft)}>
            Reload
          </button>
          {committed ? (
            <p>Saved. Choose Change settings to edit.</p>
          ) : (
            !hasReservation && draft.configuration.actions.filter((action) => !action.step).map((action) => (
              <SetupApprovalCard
                action={action}
                busy={mutationBlocked}
                key={`${action.id}-${action.consent?.consentFactsDigest}`}
                onApprove={(approval) => void change(() => setup(action, approval))}
              >
                {draft.configuration.inputRequirements
                  .filter((field) => field.actionId === action.id)
                  .map((field) => (
                    <label className="grid gap-2" key={field.id}>
                      <span>
                        {plain(field.label)}
                        {field.required ? " (required)" : ""}
                      </span>
                      <input
                        autoComplete="off"
                        onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                        required={field.required}
                        type={field.secret ? "password" : "text"}
                        value={values[field.id] ?? (field.secret ? "" : (draft.configuration.values[field.id] ?? ""))}
                      />
                      <span className="pdpp-caption text-muted-foreground">
                        {plain(field.help)} We only check the format.
                      </span>
                      {field.obtainUrl && /^https?:\/\//.test(field.obtainUrl) ? (
                        <a className="underline" href={field.obtainUrl} rel="noreferrer" target="_blank">
                          Where to get it
                        </a>
                      ) : null}
                      {field.secret ? (
                        <span className="pdpp-caption">
                          {draft.configuration.credentials[field.id]?.known
                            ? draft.configuration.credentials[field.id]?.value
                              ? "Saved. We haven't checked that it works."
                              : "Nothing saved yet."
                            : "We can't tell whether anything is saved."}
                        </span>
                      ) : null}
                    </label>
                  ))}
              </SetupApprovalCard>
            ))
          )}
          {!committed && setupAction && !hasReservation ? (
            <button type="button" disabled={mutationBlocked} onClick={() => void change(reserveSetup)}>
              Start setup
            </button>
          ) : null}
          <div className="flex flex-wrap gap-3">
            {committed ? <button type="button" disabled={mutationBlocked} onClick={() => void change(editApplied)}>Change settings</button> : null}
            <button
              disabled={mutationBlocked || !usage || (!committed && !!setupNeedsInput)}
              onClick={() =>
                void change(async () => {
                  if (!committed) {
                    const applied = await send<ReturnType<typeof projectConfiguration>>(
                      `/drafts/${encodeURIComponent(draft.draftId)}/commit`,
                      { expectedRevision: draft.configuration.revision }
                    );
                    setCommitted(true);
                    if (provider) {
                      setSelected(choiceKey({ ...provider, configuration: applied }, usage));
                    }
                  }
                  setReview(await send<Review>(`/drafts/${encodeURIComponent(draft.draftId)}/review`, { usage }));
                })
              }
            >
              {committed ? "Review" : "Save and review"}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void change(async () => {
                  await send(`/drafts/${encodeURIComponent(draft.draftId)}/discard`, {});
                  setDraft(null);
                  setReview(null);
                })
              }
            >
              Discard changes
            </button>
          </div>
        </section>
      ) : null}
      {reservations.map((reservation) => (
        <ProviderSetup
          acknowledgeDisconnect={acknowledged}
          disabled={mutationBlocked}
          key={reservation.operationId}
          reservation={reservation}
          request={request}
          onReadiness={onSetupReadiness}
          {...(!draft && reservation.draftId !== null ? { onResume: () => void change(async () => {
            const resumedDraftId = reservation.draftId as string;
            const restored = await send<Draft>(
              `/drafts/${encodeURIComponent(resumedDraftId)}?providerId=${encodeURIComponent(reservation.providerId)}`
            );
            setDraft(restored);
            setDraftProviderId(reservation.providerId);
            setUsage(reservation.usage);
            setCommitted(false);
            setReview(null);
          }) } : {})}
          onChange={async (view, mutation) => {
            if (!draft || committed || draft.draftId !== view.scope.draftId ||
                (!mutation && view.state !== "complete" && draft.configuration.revision === view.scope.configurationRevision)) return;
            setReview(null);
            await reloadDraft();
          }}
        />
      ))}
      <label className="pdpp-caption flex items-start gap-2">
        <input checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} type="checkbox" />I
        understand this page may disconnect while remote access changes.
      </label>
      {review ? (
        <RouteConsentCard
          busy={mutationBlocked}
          key={review.id}
          onApprove={(approval) =>
            void change(async () => {
              const pending = await send<{ operationId: string }>("/operations", {
                reviewId: review.id,
                ...approval,
                acknowledgeDisconnect: acknowledged,
              });
              setOperation({ ...pending, stage: "applying", recovery: null });
              setReview(null);
            })
          }
          review={review.candidate}
        />
      ) : null}
      {operation ? (
        <section aria-label="Remote access activity" className="grid gap-3">
          <p role="status">
            {operation.stage === "applying"
              ? "Working on it…"
              : operation.stage === "settled"
                ? "Done"
                : operation.stage === "unknown-possibly-live"
                  ? "We lost track of the address. It may still be on."
                  : plain(operation.stage)}
          </p>
          {operation.failureCode ? <p>{publicError(operation.failureCode).message}</p> : null}
          {operation.recovery ? (
            <>
              <p>{publicError(operation.recovery.reason).message}</p>
              <button
                disabled={!operation.recovery.available || busy}
                onClick={() =>
                  void change(async () => {
                    await send(`/operations/${encodeURIComponent(operation.operationId)}/reconcile`, {
                      action: "stop",
                      acknowledgeDisconnect: acknowledged,
                    });
                  })
                }
              >
                Check and turn off
              </button>
            </>
          ) : (
            <button
              disabled={busy}
              onClick={() =>
                void change(async () =>
                  setOperation(await send<Operation>(`/operations/${encodeURIComponent(operation.operationId)}`))
                )
              }
            >
              Check again
            </button>
          )}
          {operation.failureCode || operation.recovery ? (
            <Diagnostics>
              {operation.failureCode ? <p>Code: {operation.failureCode}</p> : null}
              {operation.recovery ? <p>Recovery: {operation.recovery.reason}</p> : null}
            </Diagnostics>
          ) : null}
        </section>
      ) : null}
      {runtimeReview ? (
        <RuntimeRouteConsentCard
          busy={busy}
          onApprove={(approval) =>
            void change(async () => {
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
                  {plain(route.binding.remedy.instructions ?? route.binding.remedy.help ?? route.binding.remedy.disclosure.text)}
                </p>
              </div>
            ) : null}
            {route.cleanup.nextAction ? (
              <p className="pdpp-caption whitespace-pre-wrap break-words">
                {plain(route.cleanup.nextAction.instructions ?? route.cleanup.nextAction.label)}
              </p>
            ) : null}
            {route.cleanup.state !== "confirmed" ? <div className="flex flex-wrap gap-3">
              {state.lifecycle?.phase === "review" && !unsupportedRefresh ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void change(async () => {
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
                    void change(async () => {
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
                  void change(async () => {
                    const pending = await send<{ operationId: string }>(
                      `/routes/${encodeURIComponent(route.handle.id)}/stop`,
                      { generation: route.handle.generation, acknowledgeDisconnect: acknowledged }
                    );
                    setOperation({ ...pending, stage: "applying", recovery: null });
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
                void change(async () => {
                  const value = port.trim() === "" ? null : Number(port);
                  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 65_535)) {
                    throw new ReachabilityFailure({ code: "invalid_input", message: "Enter a port between 1 and 65535." });
                  }
                  const updated = await send<HostSettings>("/host-settings", {
                    expectedRevision: host.value.revision,
                    mode: host.value.mode,
                    port: value,
                    acknowledgeDisconnect: acknowledged,
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
