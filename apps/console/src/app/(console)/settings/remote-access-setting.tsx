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
import { useEffect, useState } from "react";
import { requestReachability } from "./reachability-actions.ts";
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
  starting: boolean;
};

export function RemoteAccessSetting({ request = requestReachability }: { request?: typeof requestReachability }) {
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
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  async function send<T>(path: string, input?: Record<string, unknown>): Promise<T> {
    const result = await request(path, input);
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    return result.data as T;
  }
  useEffect(() => {
    let active = true;
    const pointer = sessionStorage.getItem("reachability-draft");
    if (pointer) {
      try {
        const saved = JSON.parse(pointer) as {
          providerId: string;
          draftId: string;
          usage: string | null;
          committed: boolean;
        };
        if (typeof saved.providerId === "string" && typeof saved.draftId === "string") {
          void request(
            `/drafts/${encodeURIComponent(saved.draftId)}?providerId=${encodeURIComponent(saved.providerId)}`
          ).then((result) => {
            if (!active) {
              return;
            }
            if (result.ok) {
              setDraft(result.data as Draft);
              setDraftProviderId(saved.providerId);
              setUsage(saved.usage);
              setCommitted(saved.committed === true);
            } else {
              setError(result.message);
            }
          });
        }
      } catch {
        sessionStorage.removeItem("reachability-draft");
      }
    }
    return () => {
      active = false;
    };
  }, [request]);
  useEffect(() => {
    if (draft && draftProviderId) {
      sessionStorage.setItem(
        "reachability-draft",
        JSON.stringify({ providerId: draftProviderId, draftId: draft.draftId, usage, committed })
      );
    }
  }, [draft, draftProviderId, usage, committed]);
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
        setError(catalogResult.message);
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
        if (next.operations?.length) {
          setOperation((current) => (current?.stage === "applying" ? current : (next.operations?.[0] ?? current)));
        }
      } else {
        setStale(true);
      }
    };
    void load();
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
      setError(failure instanceof Error ? failure.message : "Reachability failed");
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
    if (matches.length !== 1 || !matches[0]) throw new Error("Choose the configuration to edit again.");
    const current = matches[0];
    await send(`/drafts/${encodeURIComponent(draft.draftId)}/discard`, {});
    const next = await send<Draft>("/drafts", { providerId: current.providerId, expectedRevision: current.configuration.revision });
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
  return (
    <section aria-label="Remote access" className="grid gap-6">
      <div>
        <h2 className="pdpp-heading">Remote access</h2>
        <p className="pdpp-caption text-muted-foreground">Choose how other devices can reach this instance.</p>
      </div>
      {error ? (
        <p className="pdpp-caption text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {stale ? <p role="status">Current observations are unavailable. Changes are disabled.</p> : null}
      {state.lifecycle?.cleanup === "unconfirmed" ? (
        <p role="status">Cleanup remains unconfirmed. An unavailable ownership record does not establish absence.</p>
      ) : null}
      <section aria-label="Host settings" className="grid gap-3">
        <h3 className="pdpp-label">This instance</h3>
        {Object.entries(capabilities).map(([id, observation]) => (
          <p className="pdpp-caption" key={id}>
            {id}: {observation.known ? String(observation.value) : `Unknown: ${observation.reason}`}
          </p>
        ))}
        {host.known ? (
          <>
            <p>
              Owner password:{" "}
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
              Console port
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
                    throw new Error("Enter a port between 1 and 65535.");
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
          <p role="status">Host settings unavailable: {host.reason}. Listener changes need the host supervisor.</p>
        )}
      </section>
      <fieldset className="grid gap-3" disabled={mutationBlocked || draft !== null}>
        <legend className="pdpp-label">Reachability choices</legend>
        <label>
          <input
            checked={selected === ""}
            name="reachability"
            onChange={() => {
              setSelected("");
              setUsage(null);
            }}
            type="radio"
          />{" "}
          Off — this device only
        </label>
        {providers.map((item) => (
          <label className="grid gap-1 rounded-lg border p-3" key={choiceKey(item, usage)}>
            <span>
              <input
                checked={selected === choiceKey(item, usage)}
                name="reachability"
                onChange={() => {
                  setSelected(choiceKey(item, null));
                  setUsage(null);
                }}
                type="radio"
              />{" "}
              {item.label}
            </span>
            <span className="pdpp-caption text-muted-foreground">
              {item.reach === "lan" ? "Local network (LAN)" : item.reach} · {item.transport}
            </span>
            {Object.entries(item.availability).map(([kind, available]) => (
              <span className="pdpp-caption" key={kind}>
                {kind}: {available.state}
                {available.reason ? ` — ${available.reason}` : ""}
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
          Apply Off
        </button>
      ) : null}
      {inventory ? null : (
        <p role="status">{stale ? "Reachability choices are unavailable." : "Loading reachability choices…"}</p>
      )}
      {provider ? (
        <>
          <section aria-label="Prerequisites" className="grid gap-3">
            <h3 className="pdpp-label">Before setup</h3>
            {provider.prerequisites.map((item) => (
              <div key={item.id}>
                <p>
                  {item.label}: {item.state}
                </p>
                <p className="pdpp-caption text-muted-foreground">
                  {item.version.known ? item.version.value : item.version.reason} · {item.observedAt}
                </p>
                {item.remedy ? (
                  <p className="pdpp-caption whitespace-pre-wrap break-words">
                    {item.remedy.instructions ?? item.remedy.label}
                  </p>
                ) : (
                  <p className="pdpp-caption">No automatic fix is available.</p>
                )}
              </div>
            ))}
          </section>
          <fieldset disabled={mutationBlocked}>
            <legend className="pdpp-label">Route lifetime</legend>
            {Object.keys(provider.availability).map((kind) => (
              <label className="mr-4" key={kind}>
                <input
                  checked={usage === kind}
                  name="usage"
                  onChange={() => {
                    setUsage(kind);
                    setSelected(choiceKey(provider, kind));
                  }}
                  type="radio"
                />{" "}
                {kind}
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
        <section aria-label="Configuration draft" className="grid gap-4">
          <h3 className="pdpp-label">Staged configuration</h3>
          <button disabled={busy} onClick={() => void change(reloadDraft)}>
            Reload draft
          </button>
          {committed ? (
            <p>Configuration applied. Open a new draft to edit or rotate inputs.</p>
          ) : (
            draft.configuration.actions.map((action) => (
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
                        {field.label}
                        {field.required ? " (required)" : ""}
                      </span>
                      <input
                        autoComplete="off"
                        onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                        required={field.required}
                        type={field.secret ? "password" : "text"}
                        value={values[field.id] ?? (field.secret ? "" : (draft.configuration.values[field.id] ?? ""))}
                      />
                      <span className="pdpp-caption text-muted-foreground">{field.help} Validation: syntax only.</span>
                      {field.obtainUrl && /^https?:\/\//.test(field.obtainUrl) ? (
                        <a className="underline" href={field.obtainUrl} rel="noreferrer" target="_blank">
                          Where to get it
                        </a>
                      ) : null}
                      {field.secret ? (
                        <span className="pdpp-caption">
                          {draft.configuration.credentials[field.id]?.known
                            ? draft.configuration.credentials[field.id]?.value
                              ? "Credential saved; validity not checked."
                              : "No saved credential."
                            : "Credential presence unknown."}
                        </span>
                      ) : null}
                    </label>
                  ))}
              </SetupApprovalCard>
            ))
          )}
          <div className="flex flex-wrap gap-3">
            {committed ? <button type="button" disabled={mutationBlocked} onClick={() => void change(editApplied)}>Edit or rotate inputs</button> : null}
            <button
              disabled={mutationBlocked || !usage}
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
              {committed ? "Review route" : "Commit and review route"}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void change(async () => {
                  await send(`/drafts/${encodeURIComponent(draft.draftId)}/discard`, {});
                  sessionStorage.removeItem("reachability-draft");
                  setDraft(null);
                  setReview(null);
                })
              }
            >
              Discard draft
            </button>
          </div>
        </section>
      ) : null}
      <label className="pdpp-caption flex items-start gap-2">
        <input checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} type="checkbox" />I
        understand a remote change may disconnect this device and require local recovery.
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
        <section aria-label="Reachability operation" className="grid gap-3">
          <p role="status">
            {operation.stage === "unknown-possibly-live" ? "Unknown, possibly live" : operation.stage}
          </p>
          {operation.failureCode ? <p>{operation.failureCode}</p> : null}
          {operation.recovery ? (
            <>
              <p>{operation.recovery.reason}</p>
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
                Check / clean up
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
              Check operation
            </button>
          )}
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
      <section aria-label="Live routes" className="grid gap-4">
        {state.routes.map((route) => (
          <div className="grid gap-3 rounded-lg border p-4" key={route.handle.id}>
            <h3 className="pdpp-label">
              {state.reasons[route.handle.id] === "proof_refresh_unsupported"
                ? "Unpublished"
                : (state.lifecycle?.handle?.id === route.handle.id ? state.lifecycle.phase : route.routeState)}
            </h3>
            {state.reasons[route.handle.id] === "proof_refresh_unsupported" ? (
              <p role="status">
                This route cannot safely refresh proof. It remains unpublished. Stop it before starting a new route.
              </p>
            ) : null}
            <p className="pdpp-caption break-words">Detected address: {route.origin ?? "Unknown"}</p>
            <p className="pdpp-caption break-words">
              Requested target:{" "}
              {route.hostConfiguration.target.known
                ? route.hostConfiguration.target.value
                : `Unknown: ${route.hostConfiguration.target.reason}`}
            </p>
            <p className="pdpp-caption break-words">
              Observed binding ({route.binding.authority}):{" "}
              {route.binding.target.known ? route.binding.target.value : `Unknown: ${route.binding.target.reason}`}
            </p>
            <p className="pdpp-caption">
              {state.evidenceSource === "synthetic" ? "Synthetic fixture proof" : "Proof"}: {route.verification.status} · {route.verification.vantage} ·{" "}
              {route.verification.observedAt ?? "Unknown check time"}
            </p>
            <p className="pdpp-caption">
              {state.lifecycle?.stopRequested && state.lifecycle.confinement.known && state.lifecycle.confinement.value
                ? "Stopped locally"
                : "Local confinement not observed"}{" "}
              · Cleanup: {route.cleanup.state}
            </p>
            <ConsentFacts facts={route.facts} />
            {route.cleanup.nextAction ? (
              <p className="pdpp-caption whitespace-pre-wrap break-words">
                {route.cleanup.nextAction.instructions ?? route.cleanup.nextAction.label}
              </p>
            ) : null}
            {route.cleanup.state !== "confirmed" ? <div className="flex flex-wrap gap-3">
              {state.lifecycle?.phase === "review" && state.reasons[route.handle.id] !== "proof_refresh_unsupported" ? (
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
                  Review current route
                </button>
              ) : null}
              {!state.lifecycle?.stopRequested && state.reasons[route.handle.id] !== "proof_refresh_unsupported" ? (
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
                {route.cleanup.state === "unconfirmed" ? "Retry cleanup" : "Stop reachability"}
              </button>
            </div> : null}
          </div>
        ))}
      </section>
    </section>
  );
}
