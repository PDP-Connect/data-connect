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
import {
  adminStepCopy,
  approvalFor,
  chainAsksFields,
  isInputStep,
  isSignInChain,
  linkInHelp,
  observedComputer,
  safeSignInUrl,
  signInCopy,
  signInStage,
} from "./sign-in.ts"

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
  /** The host retained this operation solely for cleanup. */
  cleanup?: boolean
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

type Consent = NonNullable<NonNullable<SetupView["nextAction"]>["consent"]>

// The plain-words facts of the steps one click may cover.
function WhatThisDoes({ consents }: { consents: Consent[] }) {
  const shown = consents.filter(consent => consent.facts !== undefined && consent.disclosures != null)
  if (shown.length === 0) return null
  return (
    <details>
      <summary>What this does</summary>
      <div className="grid gap-3">
        {shown.map(consent => (
          <div className="grid gap-2" key={consent.consentFactsDigest}>
            <ConsentDisclosures value={consent.disclosures} />
            <ConsentFacts facts={consent.facts!} providerId={consent.scope.providerId} />
          </div>
        ))}
      </div>
    </details>
  )
}

// An account token or another typed value. A pasted secret is held by the
// field alone: it is never in state, text or a log, and it leaves only in the
// submit.
function InputCard({
  action,
  service,
  busy,
  onSubmit,
}: {
  action: NonNullable<SetupView["nextAction"]>
  service: string
  busy: boolean
  onSubmit: (approval: Approval, input: Record<string, string>) => void
}) {
  const secret = action.kind === "provide-secret"
  const secretField = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState("")
  const [filled, setFilled] = useState(false)
  const approval = approvalFor(action)
  const label = plain((secret ? action.secretLabel : action.valueLabel) ?? action.label)
  const obtain = action.obtainUrl ? safeSignInUrl(action.obtainUrl) : null
  const options = action.step?.options
  return (
    <section aria-label={`Details for ${service}`} className="grid gap-3">
      <h3 className="pdpp-label">Needs your action</h3>
      <p role="status">{secret ? `Add your ${service} token to finish.` : `Add your ${service} details to finish.`}</p>
      {action.help ? <p>{action.help}</p> : null}
      <label className="grid gap-2">
        {label}
        {secret ? (
          <input
            autoComplete="off"
            disabled={busy}
            onChange={() => setFilled(secretField.current?.value !== "")}
            ref={secretField}
            type="password"
          />
        ) : options ? (
          <select disabled={busy} onChange={event => setTyped(event.target.value)} value={typed}>
            <option value="">Choose an option</option>
            {options.map(option => (
              <option key={option.value} value={option.value}>
                {plain(option.label)}
              </option>
            ))}
          </select>
        ) : (
          <input
            autoComplete="off"
            disabled={busy}
            onChange={event => setTyped(event.target.value)}
            placeholder={action.valuePlaceholder}
            type="text"
            value={typed}
          />
        )}
      </label>
      {obtain ? (
        <a href={obtain.href} rel="noreferrer" target="_blank">
          {secret ? "Get a token" : "Where to get it"}
        </a>
      ) : null}
      {action.consent ? <WhatThisDoes consents={[action.consent]} /> : null}
      {approval ? null : <p role="status">We couldn't load this service's details. Try again.</p>}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy || !approval || (secret ? !filled : typed.trim() === "")}
          onClick={() => {
            if (!approval) return
            if (secret) {
              const value = secretField.current?.value ?? ""
              if (secretField.current) secretField.current.value = ""
              setFilled(false)
              onSubmit(approval, { secret: value })
            } else {
              const value = typed.trim()
              setTyped("")
              onSubmit(approval, { value })
            }
          }}
        >
          {secret ? "Save token" : "Save"}
        </button>
      </div>
    </section>
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
  /** True while this service's way is the one on screen. A way the owner left may show cleanup, but cannot open sign-in. */
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
  const mounted = useRef(false)
  const installedRevision = useRef(-1)
  const inFlight = useRef<object | null>(null)
  const trailingRead = useRef(false)
  function installView(next: SetupView) {
    installedRevision.current = Math.max(installedRevision.current, next.revision)
    setView(next)
  }
  const acceptObservation = useEffectEvent(async (next: SetupView, current: () => boolean) => {
    const valid = () => current() && next.revision >= installedRevision.current
    if (!valid()) return
    try {
      await onChange(next, false)
      if (valid()) {
        installView(next)
        setMissing(false)
        setError(null)
      }
    } catch {
      if (valid()) {
        setError(toDisplayError(
          new ReachabilityFailure(publicError("configuration_stale")),
          "load", reservation.providerLabel
        ))
      }
    }
  })
  const readSetup = useEffectEvent(async (): Promise<void> => {
    if (!mounted.current || busy) return
    if (inFlight.current) {
      trailingRead.current = true
      return
    }
    const flight = {}
    inFlight.current = flight
    const epoch = ++readEpoch.current
    const current = () => mounted.current && readEpoch.current === epoch
    try {
      const result = await request(readPath)
      if (!current()) return
      if (result.ok) {
        await acceptObservation(result.data as SetupView, current)
      } else {
        setMissing(result.code === "route_not_found")
        setError(toDisplayError(new ReachabilityFailure(result), "load", reservation.providerLabel))
      }
    } catch (failure) {
      if (current()) setError(toDisplayError(failure, "load", reservation.providerLabel))
    } finally {
      if (inFlight.current === flight) {
        inFlight.current = null
        const again = trailingRead.current
        trailingRead.current = false
        if (again && current()) void readSetup()
      }
    }
  })
  useEffect(() => {
    mounted.current = true
    installedRevision.current = -1
    void readSetup()
    return () => {
      mounted.current = false
      ++readEpoch.current
      inFlight.current = null
      trailingRead.current = false
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

  // `secret`: the request carried a token. A failure then shows only words fixed
  // here, chosen by its code. The server's message and any echo of the request
  // never reach state, the page or the copied details.
  async function change(run: () => Promise<SetupView>, mutation = false, kind: ActionKind = "turn-on", secret = false) {
    ++readEpoch.current
    setBusy(true)
    setError(null)
    try {
      const next = await run()
      await onChange(next, mutation)
      installView(next)
      setMissing(false)
    } catch (failure) {
      setView(null)
      const reported =
        secret ? new ReachabilityFailure(publicError(failure instanceof ReachabilityFailure ? failure.detail.code : "client_error", undefined, kind)) : failure
      setError(toDisplayError(reported, "action", reservation.providerLabel, kind))
    } finally {
      setBusy(false)
    }
  }

  // A sign-in the owner is finishing in the browser. The card's own poll
  // (`pollTick`) and a return to this window read the setup; no timer is added.
  const waitingForOwner = view !== null && signInStage(view) === "sign-in"
  const readNow = useEffectEvent(() => {
    if (busy || !waitingForOwner || !isCurrentWay()) return
    void readSetup()
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
      ++readEpoch.current
      trailingRead.current = false
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
      installView(next)
    })

  // The facts the card has shown. A step after the first runs from the same
  // click only if its facts are in this list: nothing is approved unseen.
  const [shown, setShown] = useState<Consent[]>([])
  const shownDigests = useRef(new Set<string>())
  // True from the click until the chain stops. Set synchronously, so a second click cannot start a second chain.
  const chainRunning = useRef(false)
  const [account, setAccount] = useState("")
  const [tailnet, setTailnet] = useState("")
  const [dnsUrl, setDnsUrl] = useState<string | null>(null)
  useEffect(() => {
    const next = view?.nextAction
    if (!view || !next) return
    if (next.id === "tailscale-tailnet") {
      const url = linkInHelp(next.help)
      if (url) setDnsUrl(url)
    }
    const consent = next.consent
    if (!consent?.facts || consent.disclosures == null) return
    if (!(isSignInChain(view) || signInStage(view) === "sign-in")) return
    if (shownDigests.current.has(consent.consentFactsDigest)) return
    shownDigests.current.add(consent.consentFactsDigest)
    setShown(list => [...list, consent])
  }, [view])

  // One click on the sign-in card. The click makes one immutable authorization:
  // the consent facts on the card at that moment and the setup revision. Every
  // step the chain runs, the first included, must carry facts in that set, so a
  // step with new facts stops the chain and the button comes back with them
  // shown. The authorization lives only inside this call: it ends when the chain
  // stops, finishes, or the owner leaves the way. A step that does not move the
  // setup on (same revision, or a step already run in this chain) stops it too.
  const runChain = (start: SetupView) => {
    if (chainRunning.current) return Promise.resolve()
    chainRunning.current = true
    return guarded(async () => {
      const authorization = Object.freeze({ digests: new Set(shownDigests.current), revision: start.revision })
      const ran = new Set<string>()
      let at = start
      for (let step = 0; step < 8 && isCurrentWay(); step++) {
        const next = at.nextAction
        const browser = signInStage(at) === "sign-in"
        if (!next || !(isSignInChain(at) || browser)) break
        const approval = approvalFor(next)
        if (!approval) throw new ReachabilityFailure(publicError("consent_required"))
        if (!authorization.digests.has(approval.consentFactsDigest)) break
        const key = [at.operationId, at.revision, next.id, approval.consentFactsDigest].join("\u0000")
        if (ran.has(key)) throw new ReachabilityFailure(publicError("configuration_stale"))
        ran.add(key)
        if (browser) {
          const url = await signInLink(at)
          if (!url) return
          if (!(await openResource(url.href, { kind: "external-url", newTab: false }))) {
            setNotice("Your browser didn't open. Copy the sign-in link instead.")
            break
          }
          setOpened(true)
          break
        }
        let input: Record<string, string> = {}
        if (next.id === "tailscale-account" || next.id === "tailscale-tailnet") {
          const typed = (next.id === "tailscale-account" ? account : tailnet).trim()
          if (typed === "") {
            setNotice(next.id === "tailscale-account" ? "Enter your Tailscale email." : "Enter your tailnet name.")
            break
          }
          input = { value: typed }
        } else if (next.id === "tailscale-node") {
          // The owner's click is the confirmation. The label proves only the email, not the tailnet or the computer.
          const computer = observedComputer(next)
          if (!computer) break
          input = { value: computer.value }
        }
        const response = await send<SetupView>(path, { ...input, ...command(at, next, approval) })
        if (!isCurrentWay()) return
        await onChange(response, true)
        installView(response)
        if (response.revision <= Math.max(at.revision, authorization.revision)) {
          // The host answered without moving the setup on. Stop, and let the owner try again.
          throw new ReachabilityFailure(publicError("configuration_stale"))
        }
        at = response
      }
    }).finally(() => {
      // Also runs when the owner left the way and nothing started: the chain's authorization is gone either way.
      chainRunning.current = false
    })
  }
  const checkAgain = () =>
    guarded(async () => {
      const next = await send<SetupView>(readPath)
      if (!isCurrentWay()) return
      await acceptObservation(next, () => isCurrentWay())
    })
  const openAdmin = (href: string) =>
    guarded(async () => {
      if (!(await openResource(href, { kind: "external-url", newTab: false }))) {
        setNotice("Your browser didn't open.")
      }
    })

  const action = view?.nextAction
  const holdsResources = view?.resources.some(resource => resource.removal !== "confirmed") ?? false
  const cancelButton = view && (view.state !== "cancelled" || holdsResources) ? (
    <button type="button" disabled={busy || disabled}
      onClick={() => void change(() => send<SetupView>(`${path}/cancel`, { providerId }), false, "turn-off")}>
      {reservation.cleanup || !isCurrentWay() || view.state === "complete" ? "Undo setup" : "Cancel setup"}
    </button>
  ) : null
  if (view && (reservation.cleanup || (!isCurrentWay() && isSignInChain(view)) || (view.state === "complete" && !action))) {
    if (!holdsResources || (isCurrentWay() && !reservation.cleanup)) return null
    return (
      <section aria-label={`Setup cleanup for ${plain(reservation.providerLabel)}`} className="grid gap-3">
        <p>{plain(reservation.providerLabel)} setup is still retained.</p>
        {error ? <ErrorNotice error={error} /> : null}
        {cancelButton}
      </section>
    )
  }
  if (view && isSignInChain(view) && action) {
    if (!isCurrentWay()) return null
    const service = plain(reservation.providerLabel)
    const computer = observedComputer(action)
    return (
      <section aria-label={`Sign in to ${service}`} className="grid gap-3">
        <h3 className="pdpp-label">Needs your action</h3>
        <p role="status">{`Sign in to ${service} to finish.`}</p>
        {notice ? <p role="status">{notice}</p> : null}
        {error ? <ErrorNotice error={error} /> : null}
        {cancelButton}
        {chainAsksFields(action) ? (
          <>
            <label className="grid gap-2">
              Tailscale email
              <input autoComplete="off" disabled={busy} onChange={event => setAccount(event.target.value)} type="email" value={account} />
            </label>
            <label className="grid gap-2">
              Your tailnet name (ends in .ts.net)
              <input autoComplete="off" disabled={busy} onChange={event => setTailnet(event.target.value)} type="text" value={tailnet} />
            </label>
            {dnsUrl ? (
              <a href={dnsUrl} rel="noreferrer" target="_blank">
                Find it in Tailscale
              </a>
            ) : null}
          </>
        ) : null}
        {computer ? <p>{`Tailscale found this computer: ${computer.label}.`}</p> : null}
        <WhatThisDoes consents={shown} />
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={busy || disabled} onClick={() => void runChain(view)}>
            {computer ? `Use this computer (${computer.host})` : `Sign in to ${service}`}
          </button>
        </div>
      </section>
    )
  }
  const adminCopy = view ? adminStepCopy(view) : null
  if (view && adminCopy) {
    if (!isCurrentWay()) return null
    const service = plain(reservation.providerLabel)
    return (
      <section aria-label={`Finish setting up ${service}`} className="grid gap-3">
        <h3 className="pdpp-label">Needs your action</h3>
        <p role="status">{adminCopy.line}</p>
        {notice ? <p role="status">{notice}</p> : null}
        {error ? <ErrorNotice error={error} /> : null}
        {cancelButton}
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={busy} onClick={() => void openAdmin(adminCopy.href)}>
            Open Tailscale admin
          </button>
          <button type="button" disabled={busy} onClick={() => void checkAgain()}>
            Check again
          </button>
        </div>
      </section>
    )
  }
  if (view && action && isInputStep(view)) {
    if (!isCurrentWay()) return null
    return (
      <InputCard
        key={`${view.revision}:${action.id}`}
        action={action}
        busy={busy || disabled}
        service={plain(reservation.providerLabel)}
        onSubmit={(approval, input) =>
          void change(() => send<SetupView>(path, { ...input, ...command(view, action, approval) }), true, "turn-on", "secret" in input)
        }
      />
    )
  }
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
        {error ? <ErrorNotice error={error} /> : null}
        {cancelButton}
        {stage === "sign-in" ? <WhatThisDoes consents={shown} /> : null}
        <div className="flex flex-wrap gap-3">
          {copy.button ? (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => void (stage === "sign-in" ? runChain(view) : tryAgain(view))}
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
