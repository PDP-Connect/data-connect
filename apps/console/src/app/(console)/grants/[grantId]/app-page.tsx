"use client";
import { appPlaceLine } from "../app-access-words.ts";
import { buttonVariants, IcButton } from "@pdpp/brand-react";
import { PageHeader, Section } from "@pdpp/operator-ui/components/primitives";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Button } from "@pdpp/operator-ui/ui/button";
import Link from "next/link";
import { ConnectorMark } from "../../components/connector-mark.tsx";
import { isOwnerRecordKind, sourceRecordLabel } from "../../lib/source-record-label.ts";
import { type AppAccess, appSourceName, formatAppLastRead } from "../app-access.ts";
import { personDate, personDay } from "../../history/day-cut.ts";
import { RecentReading } from "./recent-reading.tsx";
import { useAppRemoval } from "./use-app-removal.ts";

export function AppPage({
  app,
  demo,
  recent,
}: {
  app: AppAccess;
  demo?: string;
  recent?: Parameters<typeof RecentReading>[0];
}) {
  const offset = recent?.offset ?? app.offset ?? -new Date().getTimezoneOffset();
  const date = (value: string) => personDate(value, offset);
  const removal = useAppRemoval(
    app.clientIds,
    Boolean(demo),
    demo === "app-remove-question"
      ? "all"
      : demo === "app-source-question"
        ? JSON.stringify(app.sourceAccess[0]?.source)
        : null,
    demo === "app-remove-failed"
  );
  const reading = app.state === "reading" && !removal.removed.includes("all");
  const question = (key: string, title: string, sentence: string, submit: () => void, label: string) =>
    removal.question === key ? (
      <div aria-label={title} className="my-3 rounded-md border border-border p-3" role="alertdialog">
        <p>{title}</p>
        <p className="text-[13px] text-muted-foreground">{sentence}</p>
        <div className="mt-3 flex gap-2">
          <IcButton disabled={removal.busy} onClick={submit} variant="destructive">
            {label}
          </IcButton>
          <IcButton onClick={() => removal.setQuestion(null)} variant="ghost">
            Cancel
          </IcButton>
        </div>
      </div>
    ) : null;
  return (
    <>
      <Link href="/grants">Apps</Link>
      <PageHeader
        actions={
          app.state === "waiting" ? (
            <Link
              className={buttonVariants()}
              href={demo ? "/consent?demo=one" : `/grants/approvals/${encodeURIComponent(app.pendingId || app.hrefId)}`}
            >
              Review
            </Link>
          ) : undefined
        }
        title={app.name}
      />
      <p className="text-[13px] text-muted-foreground">
        {appPlaceLine(app)}
      </p>
      {reading ? (
        <div className="mt-3 flex flex-col items-start gap-2">
          {app.verified ? null : (
            <p>DataConnect could not confirm who runs this app. Remove its access if you don’t recognise it.</p>
          )}
          <IcButton onClick={() => removal.setQuestion("all")} variant="destructive">
            Remove access
          </IcButton>
          {removal.error?.source === "all" ? (
            <div className="text-destructive" role="alert">
              <p>Access could not be removed.</p>
              <IcButton disabled={removal.busy} onClick={() => void removal.remove("all")} variant="ghost">
                Try again
              </IcButton>
              <Link className="ml-3 underline" href={`/grants/${encodeURIComponent(app.hrefId)}/technical`}>
                What went wrong
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
      {app.state === "waiting" ? (
        <>
          <p>{app.name} is waiting for your answer.</p>
        </>
      ) : reading ? (
        <>
          <p className="mt-4">
            Can read your data{app.since ? ` since ${date(app.since)}` : ""}.{" "}
            {app.lastRead ? `Last read ${formatAppLastRead(app.lastRead)}.` : ""}{" "}
            {app.expiresAt ? `Access ends ${date(app.expiresAt)}.` : "Access lasts until you remove it."}
          </p>
        </>
      ) : (
        <>
          <p className="mt-4">
            No longer has access.
            {removal.removed.includes("all")
              ? " You removed it just now."
              : app.stoppedAt
                ? ` ${app.stoppedReason === "expired" ? "It ended" : "You removed it"} ${formatAppLastRead(app.stoppedAt)}.`
                : ""}
          </p>
          <p className="text-[13px] text-muted-foreground">To let it read again, connect it again from {app.name}.</p>
        </>
      )}
      {question(
        "all",
        `Remove ${app.name}'s access?`,
        `${app.name} will no longer be able to read your data. It keeps anything it already read.`,
        () => void removal.remove("all"),
        "Remove access"
      )}
      {app.state === "waiting" ? null : (
        <Section className="mt-8" title={reading ? "What it can read" : "What it could read"}>
          <ul className="divide-y divide-border">
            {app.sourceAccess
              .filter((source) => !reading || source.in_force)
              .map((source) => {
                const key = JSON.stringify(source.source);
                const name = source.name || appSourceName(source.source) || "Data source";
                const kinds =
                  source.kindNames ?? source.kinds.filter(kind=>isOwnerRecordKind(kind,source.source.connector_id??"")).map((name) => sourceRecordLabel(name));
                const canRead = reading && !removal.removed.includes(key);
                return (
                  <li className="py-4" key={key}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <ConnectorMark connectorId={source.source.connector_id || source.source.id} name={name} />
                        <div>
                          <Link
                            href={
                              source.source.connection_id
                                ? `/sources/${encodeURIComponent(source.source.connection_id)}`
                                : "/sources"
                            }
                          >
                            {name}
                          </Link>
                          <p className="text-[13px] text-muted-foreground">
                            {kinds.length > 5
                              ? `${kinds.slice(0, 3).join(", ")} and ${kinds.length - 3} more`
                              : kinds.join(", ")}
                          </p>
                          {app.since && personDay(source.first_issued_at,offset) === personDay(app.since as string,offset) ? null : (
                            <p className="text-[13px] text-muted-foreground">since {date(source.first_issued_at)}</p>
                          )}
                          <p className="text-[13px] text-muted-foreground">
                            {source.last_read_at
                              ? `Last read ${formatAppLastRead(source.last_read_at)}`
                              : source.neverRead && app.lastRead
                                ? "Has not read anything yet"
                                : ""}
                          </p>
                        </div>
                      </div>
                      {canRead ? (
                        <Button onClick={() => removal.setQuestion(key)} size="sm" variant="link">
                          Remove {name}
                        </Button>
                      ) : null}
                    </div>
                    {question(
                      key,
                      `Stop ${app.name} reading ${name}?`,
                      "It keeps anything it already read.",
                      () => void removal.remove(key, source.source),
                      "Stop"
                    )}
                    {removal.error?.source === key ? (
                      <div className="text-destructive" role="alert">
                        <p>Access could not be removed.</p>
                        <IcButton
                          disabled={removal.busy}
                          onClick={() => void removal.remove(key, source.source)}
                          variant="ghost"
                        >
                          Try again
                        </IcButton>
                        <Link className="ml-3 underline" href={`/grants/${encodeURIComponent(app.hrefId)}/technical`}>
                          What went wrong
                        </Link>
                      </div>
                    ) : null}
                  </li>
                );
              })}
          </ul>
        </Section>
      )}
      {recent ? <RecentReading {...recent} app={app} demo={demo} /> : null}
      <Link
        className="mt-6 inline-block text-[13px] text-muted-foreground"
        href={`/grants/${encodeURIComponent(app.hrefId)}/technical${demo ? `?demo=${encodeURIComponent(demo)}` : ""}`}
      >
        Technical details
      </Link>
    </>
  );
}
