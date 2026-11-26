// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { ConnectorMark } from "../../components/connector-mark.tsx";
import { clockLabel, sentenceDayLabel, startedAgo, personDay } from "../../history/day-cut.ts";
import { StopCopying } from "../../connect/status/[connectionId]/stop-copying.tsx";
import { resolveSyncCause } from "../../history/sync-cause.ts";
import { buttonVariants } from "@/components/ui/button";
import { RunInteractionForm } from "./interaction-form.tsx";
import { durationWords, recordKindName, type OneSyncModel } from "./one-sync-model.ts";
export function OneSyncView({ model, offset, practice = false }: { model: OneSyncModel; offset: number; practice?: boolean }) {
  const m = model; const took = durationWords(m.started,m.completed);
  const sentence = m.outcome === "finished" ? `Finished.${took ? ` It took ${took}.` : ""}`
    : m.outcome === "syncing" ? `Syncing now.${m.started ? ` Started ${startedAgo(m.started)}.` : ""}`
    : m.outcome === "needs_you" ? "Needs you to finish signing in."
    : m.outcome === "could_not_start" ? "Could not start. It will try again at the next check."
    : m.outcome === "stopped" ? "You stopped this. What was copied before you stopped is kept."
    : m.outcome === "interrupted" ? "Interrupted when DataConnect restarted. It will try again at the next check."
    : `Failed${took ? ` after ${took}` : ""}.`;
  const cause = resolveSyncCause(m.evidence ?? {reason:m.cause},m.name);
  return <>
    <PageHeader breadcrumbs={[{ href: "/syncs", label: "Sync history" }, { href: m.connection ? `/sources/${encodeURIComponent(m.connection)}` : "/sources", label: m.name }]} title={<span className="inline-flex items-center gap-3"><ConnectorMark connectorId={m.connector} name={m.name} /><span>{m.name}{m.at ? `, ${sentenceDayLabel(personDay(m.at,offset),offset)} at ${clockLabel(m.at,offset)}` : ""}</span></span>} />
    <p className={m.outcome === "failed" || m.outcome === "needs_you" ? "text-destructive" : "text-foreground"}>{sentence}</p>
    {m.outcome === "failed" ? <><p>{cause.sentence}</p>{m.retryHref ? <Link className={buttonVariants()} href={m.retryHref}>{cause.action}</Link> : <p>See {m.name} to try again.</p>}</> : null}
    {m.outcome === "syncing" ? <StopCopying name={m.name} runId={m.id} preview={practice} /> : null}
    {m.outcome === "needs_you" ? <Link className="inline-block min-h-11 py-3 text-primary" href={`/syncs/${encodeURIComponent(m.id)}/stream`}>Continue</Link> : null}
    {m.assistance?.kind === "credentials" && m.assistance.responseContract === "response_required" && m.assistance.ownerAction === "provide_value" ? <RunInteractionForm fields={m.assistance.fields} interactionId={m.assistance.id} kind={m.assistance.kind} message={m.assistance.message} runId={m.id} serviceName={m.name} heading={false} preview={practice} /> : null}
    {m.trigger ? <p className="mb-6 text-[13px] text-muted-foreground">{m.trigger === "manual" ? "You started it." : m.trigger === "scheduled" ? "Started by the schedule." : m.trigger === "retry" ? "A second try after a failure." : ""}</p> : null}
    {m.kinds?.some(kind => kind.count > 0) ? <Section title="What it brought"><ul className="divide-y divide-border">{m.kinds.filter(kind=>kind.count>0).map(kind => <li className="py-3" key={kind.kind}><Link className="flex justify-between gap-4" href={`/sources/${encodeURIComponent(m.connection ?? m.connector)}/${encodeURIComponent(kind.kind)}`}><span>{m.kindNames?.[kind.kind] ?? recordKindName(kind.kind)}</span><span>{kind.count} new records</span></Link></li>)}</ul></Section> : m.total !== null && ["finished","stopped","interrupted","failed"].includes(m.outcome) ? <p className="my-6">{m.total ? `${m.total} new records.` : "Nothing new this time."}</p> : null}
    {m.missing.length ? <Section title="Didn't come">{m.missing.map(row => <div className="py-3" key={row.name}><p>{row.name}</p><p>DataConnect could not copy this.</p>{row.canRetry ? <p>It will try again the next time DataConnect checks {m.name}.</p> : null}</div>)}</Section> : null}
    {m.connection ? <p className="my-6"><Link href={`/sources/${encodeURIComponent(m.connection)}`}>See {m.name}</Link></p> : null}
    <Link className="text-[13px] text-muted-foreground" href={`/syncs/${encodeURIComponent(m.id)}/technical${practice ? "?demo=technical" : ""}`}>Technical details</Link>
  </>;
}
