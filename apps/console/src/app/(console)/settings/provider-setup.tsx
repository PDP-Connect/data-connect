"use client"
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useEffectEvent, useRef, useState } from "react"
import type { projectSetupOperation } from "pdpp-reference-implementation/reachability-projection"
import { openResource } from "../../../../../../src/lib/open-resource"
import type { requestReachability } from "./reachability-actions.ts"
import {
  ConsentDisclosures,
  ConsentFacts,
  SetupApprovalCard,
} from "./reachability-consent.tsx"
import {
  type DisplayError,
  ErrorNotice,
  ReachabilityFailure,
  toDisplayError,
} from "./diagnostics.tsx"
import { plain } from "./plain-text.ts"
import { type ActionKind, publicError } from "./reachability-errors.ts"
import { approvalFor, safeSignInUrl, signInCopy, signInStage } from "./sign-in.ts"

type SetupView = ReturnType<typeof projectSetupOperation>
type Request = typeof requestReachability
type Approval = Parameters<
  Parameters<typeof SetupApprovalCard>[0]["onApprove"]
>[0]

export type SetupReservation = {
  operationId: string
  providerId: string
  providerLabel: string
  draftId: string | null
  actionId: string
  expectedConfigurationRevision: string
  usage: string | null
}

export function reserveSetupOperation(
  request: Request,
  reservation: SetupReservation
) {
  const {
    operationId,
    providerId,
    draftId,
    actionId,
    expectedConfigurationRevision,
  } = reservation
  return request(`/setup-operations/${encodeURIComponent(operationId)}`, {
    providerId,
    ...(draftId === null ? {} : { draftId }),
    actionId,
    expectedConfigurationRevision,
    expectedSetupRevision: 0,
  })
}

const status: Record<SetupView["state"], (service: string) => string> = {
  "authorization-required": service => `Sign in to ${service} to finish.`,
  pending: () => "Waiting for you to finish signing in…",
  denied: service => `${service} sign-in was cancelled.`,
  expired: service => `${service} sign-in took too long.`,
  blocked: () => "Needs your action",
  reconciling: () => "Turning off…",
  complete: () => "Ready to turn on",
  cancelled: () => "Setup cancelled",
}

function SetupOperationAction({
  action,
  busy,
  onApprove,
}: {
  action: NonNullable<SetupView["nextAction"]>
  busy: boolean
  onApprove: (approval: Approval, input: Record<string, string>) => void
}) {
  const [value, setValue] = useState("")
  const secret = action.kind === "provide-secret"
  const needsInput = secret || action.kind === "provide-value"
  const label =
    plain((secret ? action.secretLabel : action.valueLabel) ?? action.label)
  const consent = action.consent
  const obtain = action.obtainUrl ? URL.parse(action.obtainUrl) : null
  if (
    action.kind === "instructions" ||
    (action.kind === "open-url" && !action.step?.browser)
  ) {
    const url = action.href ? URL.parse(action.href) : null
    return (
      <div className="grid gap-2">
        <h4 className="pdpp-label">{plain(action.label)}</h4>
        <p>{action.instructions ?? action.help ?? action.disclosure.text}</p>
        {url?.protocol === "https:" && !url.username && !url.password ? (
          <a href={url.href} rel="noreferrer" target="_blank">
            {plain(action.label)}
          </a>
        ) : null}
        {consent?.disclosures ? (
          <ConsentDisclosures value={consent.disclosures} />
        ) : null}
        {consent?.facts ? <ConsentFacts facts={consent.facts} providerId={consent.scope.providerId} /> : null}
      </div>
    )
  }
  return (
    <SetupApprovalCard
      action={action}
      busy={busy || (needsInput && !value)}
      buttonLabel={
        action.kind === "open-url"
          ? "Approve and open in browser"
          : plain(action.label)
      }
      onApprove={approval => {
        setValue("")
        onApprove(
          approval,
          needsInput ? { [secret ? "secret" : "value"]: value } : {}
        )
      }}
    >
      {action.instructions || action.help ? (
        <p>{action.instructions ?? action.help ?? ""}</p>
      ) : null}
      {obtain?.protocol === "https:" && !obtain.username && !obtain.password ? (
        <a href={obtain.href} rel="noreferrer" target="_blank">
          Where to get it
        </a>
      ) : null}
      {needsInput ? (
        <label className="grid gap-2">
          {label}
          {action.step?.options ? (
            <select
              disabled={busy}
              onChange={event => setValue(event.target.value)}
              value={value}
            >
              <option value="">Choose an option</option>
              {action.step.options.map(option => (
                <option key={option.value} value={option.value}>
                  {plain(option.label)}
                </option>
              ))}
            </select>
          ) : (
            <input
              autoComplete="off"
              disabled={busy}
              onChange={event => setValue(event.target.value)}
              placeholder={action.valuePlaceholder}
              type={secret ? "password" : "text"}
              value={value}
            />
          )}
        </label>
      ) : null}
    </SetupApprovalCard>
  )
}

export function ProviderSetup({
  reservation,
  request,
  disabled,
  onChange,
  onReadiness,
  onResume,
  acknowledgeDisconnect,
  pollTick = 0,
  isCurrentWay = () => true,
}: {
  reservation: SetupReservation
  request: Request
  disabled: boolean
  onChange: (view: SetupView, mutation: boolean) => Promise<void>
  onReadiness: (draftId: string, revision: string | null) => void
  onResume?: () => void
  acknowledgeDisconnect: boolean
  /** Bumped by the card's own 3-second poll. A waiting sign-in reads its setup on each bump. */
  pollTick?: number
  /** True while this service's way is the one on screen. A way the owner left shows and opens nothing. */
  isCurrentWay?: () => boolean
}) {
  const [view, setView] = useState<SetupView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<DisplayError | null>(null)
  const [missing, setMissing] = useState(false)
  const { operationId, providerId, draftId } = reservation
  const path = `/setup-operations/${encodeURIComponent(operationId)}`
  const readPath = `${path}?providerId=${encodeURIComponent(providerId)}`
  const revision = view?.state === "complete" && !busy ? view.scope.configurationRevision : null
  useEffect(() => {
    if (draftId !== null) onReadiness(draftId, revision)
  }, [draftId, onReadiness, revision])

  const readEpoch = useRef(0)
  const acceptObservation = useEffectEvent(async (next: SetupView, current: () => boolean) => {
    if (!current()) return
    try {
      await onChange(next, false)
      if (current()) {
        setView(next)
        setError(null)
      }
    } catch {
      if (current()) {
        setView(null)
        setError(
          toDisplayError(
            new ReachabilityFailure(publicError("configuration_stale")),
            "load",
            reservation.providerLabel
          )
        )
      }
    }
  })

  useEffect(() => {
    let active = true
    async function load() {
      const epoch = readEpoch.current
      const current = () => active && readEpoch.current === epoch
      const result = await request(readPath)
      if (!current()) return
      if (result.ok) {
        await acceptObservation(result.data as SetupView, current)
      } else {
        setMissing(result.code === "route_not_found")
        setError(
          toDisplayError(
            new ReachabilityFailure(result),
            "load",
            reservation.providerLabel
          )
        )
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [request, readPath])

  async function send<T>(
    target: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const result = await request(target, body)
    if (!result.ok) throw new ReachabilityFailure(result)
    return result.data as T
  }

  async function change(run: () => Promise<SetupView>, mutation = false, kind: ActionKind = "turn-on") {
    ++readEpoch.current
    setBusy(true)
    setError(null)
    try {
      const next = await run()
      await onChange(next, mutation)
      setView(next)
      setMissing(false)
    } catch (failure) {
      setView(null)
      setError(toDisplayError(failure, "action", reservation.providerLabel, kind))
    } finally {
      setBusy(false)
    }
  }

  // A sign-in the owner is finishing in the browser. The card's own poll
  // (`pollTick`) and a return to this window read the setup; no timer is added.
  const waitingForOwner = view !== null && signInStage(view) === "sign-in"
  const readNow = useEffectEvent(async () => {
    if (busy || !isCurrentWay()) return
    const epoch = readEpoch.current
    const current = () => readEpoch.current === epoch && isCurrentWay()
    const result = await request(readPath)
    if (current() && result.ok) await acceptObservation(result.data as SetupView, current)
  })
  useEffect(() => {
    if (pollTick > 0 && waitingForOwner) void readNow()
  }, [pollTick])
  useEffect(() => {
    if (!waitingForOwner) return
    const onReturn = () => void readNow()
    window.addEventListener("focus", onReturn)
    window.addEventListener("pageshow", onReturn)
    return () => {
      window.removeEventListener("focus", onReturn)
      window.removeEventListener("pageshow", onReturn)
    }
  }, [waitingForOwner])

  // The sign-in card: words, one primary button, and a copy-link fallback.
  const [opened, setOpened] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const stage = view ? signInStage(view) : null
  useEffect(() => {
    if (stage !== "sign-in") setOpened(false)
  }, [stage])
  function command(setup: SetupView, action: NonNullable<SetupView["nextAction"]>, approval: Approval) {
    return {
      approval,
      providerId,
      actionId: action.id,
      ...(setup.scope.draftId === null ? {} : { draftId: setup.scope.draftId }),
      expectedConfigurationRevision: setup.scope.configurationRevision,
      expectedSetupRevision: setup.revision,
      acknowledgeDisconnect,
    }
  }
  // Asks the host for the sign-in link. Null when this way is no longer the one on screen.
  async function signInLink(setup: SetupView): Promise<URL | null> {
    const action = setup.nextAction
    const approval = action ? approvalFor(action) : null
    if (!action || !approval) throw new ReachabilityFailure(publicError("consent_required"))
    const handoff = await send<{ href: string }>(`${path}/handoff`, command(setup, action, approval))
    if (!isCurrentWay()) return null
    const url = safeSignInUrl(handoff.href)
    if (!url) throw new ReachabilityFailure(publicError("setup_action_unavailable"))
    return url
  }
  async function guarded(run: () => Promise<void>) {
    if (!isCurrentWay()) return
    ++readEpoch.current
    setBusy(true)
    setNotice(null)
    try {
      await run()
    } catch (failure) {
      setNotice(toDisplayError(failure, "action", reservation.providerLabel).message)
    } finally {
      setBusy(false)
    }
  }
  const openSignIn = (setup: SetupView) =>
    guarded(async () => {
      const url = await signInLink(setup)
      if (!url) return
      if (!(await openResource(url.href, { kind: "external-url", newTab: false }))) {
        setNotice("Your browser didn't open. Copy the sign-in link instead.")
        return
      }
      setOpened(true)
    })
  const copySignIn = (setup: SetupView) =>
    guarded(async () => {
      const url = await signInLink(setup)
      if (!url) return
      try {
        await window.navigator.clipboard.writeText(url.href)
        setNotice("Sign-in link copied.")
      } catch {
        setNotice("Couldn't copy the link.")
      }
    })
  const tryAgain = (setup: SetupView) =>
    guarded(async () => {
      const action = setup.nextAction
      const approval = action ? approvalFor(action) : null
      // The same setup runs its sign-in step again. A setup with no step to run is read once more.
      const next =
        action && approval
          ? await send<SetupView>(path, command(setup, action, approval))
          : await send<SetupView>(readPath)
      if (!isCurrentWay()) return
      await onChange(next, true)
      setView(next)
    })

  const action = view?.nextAction
  // A finished setup has nothing left to show: the flow goes on to Turning on.
  if (view?.state === "complete" && !action) return null
  if (view && stage) {
    // A way the owner has left shows nothing and opens nothing.
    if (!isCurrentWay()) return null
    const service = plain(reservation.providerLabel)
    const copy = signInCopy(stage, service, opened)
    return (
      <section aria-label={`Sign in to ${service}`} className="grid gap-3">
        <h3 className="pdpp-label">Needs your action</h3>
        <p role="status">{copy.line}</p>
        {notice ? <p role="status">{notice}</p> : null}
        <div className="flex flex-wrap gap-3">
          {copy.button ? (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => void (stage === "sign-in" ? openSignIn(view) : tryAgain(view))}
            >
              {copy.button}
            </button>
          ) : null}
          {stage === "sign-in" ? (
            <button type="button" disabled={busy} onClick={() => void copySignIn(view)}>
              Copy sign-in link
            </button>
          ) : null}
        </div>
      </section>
    )
  }
  return (
    <section
      aria-label={`Setup for ${plain(reservation.providerLabel)}`}
      className="grid gap-3"
    >
      <h3 className="pdpp-label">{plain(reservation.providerLabel)} setup</h3>
      <p role="status">
        {view
          ? status[view.state](plain(reservation.providerLabel))
          : error
            ? "Current setup status unavailable"
            : "Checking setup status…"}
      </p>
      {error ? <ErrorNotice error={error} /> : null}
      {view?.evidence.known ? <p>{plain(view.evidence.value.summary)}</p> : null}
      {view?.resources.length ? (
        <ul aria-label="Setup resources">
          {view.resources.map(resource => (
            <li key={resource.handle}>
              {plain(resource.label)} · {plain(resource.ownership)} ·{" "}
              {resource.removal === "required"
                ? "Removal pending"
                : resource.removal === "unconfirmed"
                  ? "Removal unconfirmed"
                  : resource.removal === "confirmed"
                    ? "Removal confirmed"
                    : "Retained"}
            </li>
          ))}
        </ul>
      ) : null}
      {view && action ? (
        <SetupOperationAction
          key={`${view.revision}:${action.consent?.consentFactsDigest}`}
          action={action}
          busy={busy || disabled}
          onApprove={(approval, input) =>
            void change(async () => {
              const command = {
                ...input,
                approval,
                providerId,
                actionId: action.id,
                ...(view.scope.draftId === null
                  ? {}
                  : { draftId: view.scope.draftId }),
                expectedConfigurationRevision: view.scope.configurationRevision,
                expectedSetupRevision: view.revision,
                acknowledgeDisconnect,
              }
              if (action.kind === "open-url") {
                const handoff = await send<{ href: string }>(
                  `${path}/handoff`,
                  command
                )
                const url = URL.parse(handoff.href)
                if (
                  !url ||
                  url.protocol !== "https:" ||
                  url.username ||
                  url.password ||
                  !(await openResource(url.href, {
                    kind: "external-url",
                    newTab: false,
                  }))
                ) {
                  throw new ReachabilityFailure({
                    code: "browser_not_opened",
                    message: "Your browser didn't open. Copy the sign-in link instead.",
                  })
                }
                return send<SetupView>(readPath)
              }
              return send<SetupView>(path, command)
            }, action.kind !== "open-url")
          }
        />
      ) : null}
      <div className="flex flex-wrap gap-3">
        {onResume &&
        view?.scope.draftId &&
        !["cancelled", "denied", "expired"].includes(view.state) ? (
          <button type="button" disabled={busy || disabled} onClick={onResume}>
            Resume setup
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void change(() => send<SetupView>(readPath), false, "check")}
        >
          Check setup status
        </button>
        {missing ? (
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() =>
              void change(() =>
                reserveSetupOperation(request, reservation).then(result => {
                  if (!result.ok) throw new ReachabilityFailure(result)
                  return result.data as SetupView
                })
              )
            }
          >
            Retry setup
          </button>
        ) : null}
        {view && view.state !== "cancelled" ? (
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() =>
              void change(() => send<SetupView>(`${path}/cancel`, { providerId }), false, "turn-off")
            }
          >
            {view.state === "complete" ? "Undo setup" : "Cancel setup"}
          </button>
        ) : null}
      </div>
    </section>
  )
}
