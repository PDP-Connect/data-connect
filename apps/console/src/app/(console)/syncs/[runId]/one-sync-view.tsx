// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { SyncNowButton } from "../../sources/[connector]/sync-now-button.tsx";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { ConnectorMark } from "../../components/connector-mark.tsx";
import { clockLabel, sentenceDayLabel, startedAgo, personDay } from "../../history/day-cut.ts";
import { StopCopying } from "../../connect/status/[connectionId]/stop-copying.tsx";
import { isOwnerRecordKind } from "../../lib/source-record-label.ts";
import { copiedRecords, resolveSyncCause } from "../../lib/sync-cause.ts";
import { buttonVariants } from "@pdpp/brand-react";
import { RunInteractionForm } from "./interaction-form.tsx";
import { currentStateAddsToFailure, durationWords, hereNowTitle, recordKindName, type OneSyncModel } from "./one-sync-model.ts";
export function OneSyncView({ model, offset, practice = false }: { model: OneSyncModel; offset: number; practice?: boolean }) {
  const m = model; const took = durationWords(m.started,m.completed);
  // The one sentence and tone the source page uses for this state, from the shared status words.
  const answer = m.currentSource?.currentAnswer;
  const waiting = answer?.row === 8 ? answer.sentence.text.split(/(?<=\.)\s/)[0] ?? null : null;
  const sentence = m.outcome === "finished" ? `Finished.${took ? ` It took ${took}.` : ""}`
    : m.outcome === "syncing" ? `Syncing now.${m.started ? ` Started ${startedAgo(m.started)}.` : ""}`
    : m.outcome === "needs_you" ? (waiting ?? "Needs you to finish signing in.")
    : m.outcome === "could_not_start" ? "DataConnect could not start this sync."
    : m.outcome === "stopped" ? "You stopped this. What was copied before you stopped is kept."
    : m.outcome === "interrupted" ? "Interrupted when DataConnect restarted."
    : `Failed${took ? ` after ${took}` : ""}.`;
  const cause = resolveSyncCause(m.evidence ?? {reason:m.cause},m.currentSource?.serviceName ?? m.name);
  return <>
    <PageHeader breadcrumbs={[{ href: "/syncs", label: "Sync history" }, { href: m.connection ? `/sources/${encodeURIComponent(m.connection)}` : "/sources", label: m.name }]} title={<span className="inline-flex items-center gap-3"><ConnectorMark connectorId={m.connector} name={m.name} /><span>{m.name}{m.at ? `, ${sentenceDayLabel(personDay(m.at,offset),offset)} at ${clockLabel(m.at,offset)}` : ""}</span></span>} />
    <div className="mb-8 space-y-3"><p className={m.outcome === "failed" ? "text-destructive" : m.outcome === "needs_you" ? "font-medium text-attention" : "text-foreground"}>{sentence}</p>
    {m.outcome === "failed" ? <p>{cause.sentence}</p> : null}
    {m.currentSource?.currentState && m.outcome !== "needs_you" && currentStateAddsToFailure(m.outcome, cause.sentence, m.currentSource.currentState) ? <p>{m.currentSource.currentState}</p> : null}
    {m.currentSource?.currentAnswer?.action && m.retryHref && m.outcome !== "needs_you" ? (m.currentSource.currentAnswer.action.kind === "sync_now" && m.connection ? <SyncNowButton connectionId={m.connection} connectorId={m.connector} displayName={m.name} idleLabel={m.currentSource.currentAnswer.action.label} initialRunning={false} variant="default" /> : <Link className={buttonVariants()} href={m.retryHref}>{m.currentSource.currentAnswer.action.label}</Link>) : null}
    {m.outcome === "syncing" ? <StopCopying name={m.name} runId={m.id} preview={practice} /> : null}
    {m.outcome === "needs_you" ? <Link className={buttonVariants()} href={`/syncs/${encodeURIComponent(m.id)}/stream`}>{m.currentSource?.currentAnswer?.action?.label ?? "Continue"}</Link> : null}
    {m.assistance?.kind === "credentials" && m.assistance.responseContract === "response_required" && m.assistance.ownerAction === "provide_value" ? <RunInteractionForm fields={m.assistance.fields} interactionId={m.assistance.id} kind={m.assistance.kind} message={m.assistance.message} runId={m.id} serviceName={m.name} heading={false} preview={practice} /> : null}
    {m.trigger ? <p className="mb-6 text-[13px] text-muted-foreground">{m.trigger === "manual" ? "You started it." : m.trigger === "scheduled" ? "Automatic" : m.trigger === "retry" ? "A second try after a failure." : ""}</p> : null}
    </div>
    {m.kinds?.some(kind => kind.count > 0) ? <Section title="What it brought"><ul className="divide-y divide-border">{m.kinds.filter(kind=>kind.count>0 && isOwnerRecordKind(kind.kind,m.connector)).map(kind => <li className="py-3" key={kind.kind}><Link className="flex justify-between gap-4" href={`/sources/${encodeURIComponent(m.connection ?? m.connector)}/${encodeURIComponent(kind.kind)}`}><span>{m.kindNames?.[kind.kind] ?? recordKindName(kind.kind)}</span><span>{copiedRecords(kind.count)}</span></Link></li>)}</ul></Section> : m.total !== null && (["finished","stopped","interrupted"].includes(m.outcome) || m.total > 0) ? <p className="my-6">{m.total === 0 ? "Nothing to copy." : `Copied ${m.total.toLocaleString("en-US")} record${m.total === 1 ? "" : "s"}.`}</p> : null}
    {m.currentSource?.currentKinds ? <Section title={hereNowTitle(m.outcome, Boolean(m.kinds?.some(kind => kind.count > 0)))}><ul>{Object.entries(m.currentSource.currentKinds).map(([kind,value])=><li key={kind}>{m.kindNames?.[kind] ?? recordKindName(kind)} · {value.line}</li>)}</ul></Section> : null}
    {m.missing.some(row=>row.name === "records") ? <p>Some records didn’t come.</p> : null}
    {m.missing.some(row=>row.name !== "records") ? <Section title="Didn't come">{m.missing.filter(row=>row.name!=="records").map(row => <div className="py-3" key={row.name}><p>{row.name}</p><p>Didn’t come at this sync.</p></div>)}</Section> : null}
    {m.connection ? <p className="my-6"><Link className="text-primary underline-offset-4 hover:underline" href={`/sources/${encodeURIComponent(m.connection)}`}>See {m.name}</Link></p> : null}
    <Link className="text-[13px] text-muted-foreground" href={`/syncs/${encodeURIComponent(m.id)}/technical${practice ? "?demo=technical" : ""}`}>Technical details</Link>
  </>;
}
