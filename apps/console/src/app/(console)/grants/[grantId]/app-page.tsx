"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { IcButton } from "@pdpp/brand-react";
import { Section, PageHeader } from "@pdpp/operator-ui/components/primitives";
import { humanizeFieldLabel } from "@pdpp/display";
import Link from "next/link";
import { ConnectorMark } from "../../components/connector-mark.tsx";
import { appSourceName, formatAppLastRead, type AppAccess } from "../app-access.ts";
import { useAppRemoval } from "./use-app-removal.ts";
import { RecentReading } from "./recent-reading.tsx";
const date = (value: string) =>
  new Date(value).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
export function AppPage({
  app,
  demo,
  recent,
}: {
  app: AppAccess;
  demo?: string;
  recent?: Parameters<typeof RecentReading>[0];
}) {
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
      <div className="my-3 rounded-md border border-border p-3" role="alertdialog" aria-label={title}>
        <p>{title}</p>
        <p className="text-[13px] text-muted-foreground">{sentence}</p>
        <div className="mt-3 flex gap-2">
          <IcButton variant="destructive" disabled={removal.busy} onClick={submit}>
            {label}
          </IcButton>
          <IcButton variant="ghost" onClick={() => removal.setQuestion(null)}>
            Cancel
          </IcButton>
        </div>
      </div>
    ) : null;
  return (
    <>
      <Link href="/grants">Apps</Link>
      <PageHeader
        title={app.name}
        actions={
          reading ? (
            <IcButton variant="ghost" className="text-destructive" onClick={() => removal.setQuestion("all")}>
              Remove access
            </IcButton>
          ) : app.state === "waiting" ? (
            <Link
              href={
                demo ? "/consent?demo=one" : `/grants/approvals/${encodeURIComponent(app.pendingId || app.hrefId)}`
              }
            >
              Review
            </Link>
          ) : undefined
        }
      />
      <p className="text-[13px] text-muted-foreground">
        {app.place}
        {!app.verified ? " · not verified" : ""}
      </p>
      {!app.verified ? (
        <p className="text-[13px] text-muted-foreground">
          DataConnect could not confirm who runs this app. Allow it only if you started this yourself, in {app.place}.
        </p>
      ) : null}
      {app.state === "waiting" ? (
        <>
          <p>{app.name} is waiting for your answer.</p>
        </>
      ) : reading ? (
        <>
          <p className="mt-4">
            Can read your data{app.since ? ` since ${date(app.since)}` : ""}.{" "}
            {app.lastRead ? `Last read ${formatAppLastRead(app.lastRead)}.` : app.neverRead ? "Has not read anything yet." : ""}{" "}
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
      {removal.error?.source === "all" ? (
        <div role="alert">
          <p>Access could not be removed. Try again.</p>
          <details>
            <summary>What went wrong</summary>
            {removal.error.message}
          </details>
        </div>
      ) : null}
      {app.state !== "waiting" ? (
        <Section title={reading ? "What it can read" : "What it could read"}>
          <ul className="divide-y divide-border">
            {app.sourceAccess
              .filter((source) => !reading || source.in_force)
              .map((source) => {
                const key = JSON.stringify(source.source);
                const name = source.name || appSourceName(source.source) || "Data source";
                const kinds = source.kinds.map(humanizeFieldLabel);
                const canRead = reading && !removal.removed.includes(key);
                return (
                  <li className="py-4" key={key}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <ConnectorMark connectorId={source.source.connector_id || source.source.id} name={name} />
                        <div>
                          <Link
                            href={`/sources/${encodeURIComponent(source.source.connection_id || source.source.id)}`}
                          >
                            {name}
                          </Link>
                          <p className="text-[13px] text-muted-foreground">
                            {kinds.length > 5
                              ? `${kinds.slice(0, 3).join(", ")} and ${kinds.length - 3} more`
                              : kinds.join(", ")}
                          </p>
                          {source.first_issued_at !== app.since ? (
                            <p className="text-[13px] text-muted-foreground">since {date(source.first_issued_at)}</p>
                          ) : null}
                          <p className="text-[13px] text-muted-foreground">
                            {source.last_read_at
                              ? `Last read ${formatAppLastRead(source.last_read_at)}`
                              : source.neverRead ? "Has not read anything yet" : ""}
                          </p>
                        </div>
                      </div>
                      {canRead ? (
                        <IcButton variant="ghost" onClick={() => removal.setQuestion(key)}>
                          Remove
                        </IcButton>
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
                      <div role="alert">
                        <p>
                          {removal.error.message.includes("permission covers other connections")
                            ? `${app.name}’s access to ${name} can’t be removed by itself. Remove all of ${app.name}’s access instead.`
                            : "Access could not be removed. Try again."}
                        </p>
                        <details>
                          <summary>What went wrong</summary>
                          {removal.error.message}
                        </details>
                      </div>
                    ) : null}
                  </li>
                );
              })}
          </ul>
        </Section>
      ) : null}
      {recent ? <RecentReading {...recent} demo={demo} /> : null}
      <Link
        className="mt-6 inline-block text-[13px] text-muted-foreground"
        href={`/grants/${encodeURIComponent(app.hrefId)}/technical${demo ? `?demo=${encodeURIComponent(demo)}` : ""}`}
      >
        Technical details
      </Link>
    </>
  );
}
