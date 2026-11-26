"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { buttonVariants, IcButton, IcInput, Text } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AppAccess } from "./app-access.ts";
import { AppAccessList } from "./app-access-list.tsx";
import { removeAppAction } from "./remove-app-action.ts";
import { appSourceCount, removeUnusedApps, unusedApps } from "./unused-apps.ts";
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The three access states share one filter and one removal state; keeping the composition together makes their boundaries visible.
export function AppsGroups({
  apps,
  demo,
  waiting,
}: {
  apps: AppAccess[];
  demo?: string;
  waiting?: { name: string; place: string; node: React.ReactNode }[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const reading = apps.filter((app) => app.state === "reading" && !removed.includes(app.hrefId));
  const unused = unusedApps(reading);
  const chosen = unused.filter(app => selected.includes(app.hrefId)).sort((a,b) => (a.since || "").localeCompare(b.since || ""));
  const recent = reading.filter((app) => !unused.includes(app));
  const matches = (app: AppAccess) => `${app.name} ${app.place}`.toLowerCase().includes(query.trim().toLowerCase());
  const stopped = apps
    .filter((app) => app.state === "stopped" || removed.includes(app.hrefId))
    .sort((a, b) => (b.stoppedAt || "").localeCompare(a.stoppedAt || ""));
  async function remove() {
    setBusy(true);
    setFailed([]);
    try {
      const result = await removeUnusedApps(chosen, demo ? () => Promise.resolve({ ok: true, message: null }) : removeAppAction);
      setFailed(result.failedNames);
      if (result.ok) {
        setConfirm(false);
        setRemoved((previous) => [...previous, ...chosen.map((app) => app.hrefId)]);
      }
      if (!demo) {
        router.refresh();
      }
    } catch {
      setFailed(chosen.map((app) => app.name));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {apps.length > 10 ? (
        <IcInput
          aria-label="Find an app"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find an app"
          value={query}
        />
      ) : null}
      {waiting?.length ? (
        <Section id="pending-approvals" title="Waiting for you">
          <ul>
            {waiting
              .filter((row) => `${row.name} ${row.place}`.toLowerCase().includes(query.trim().toLowerCase()))
              .map((row, index) => (
                <li key={index}>{row.node}</li>
              ))}
          </ul>
        </Section>
      ) : null}
      {reading.length ? (
        <Section title={`Can read your data${reading.length > 5 ? ` · ${reading.length}` : ""}`}>
          {recent.length ? <AppAccessList apps={recent} demo={demo} query={query} /> : null}
          {unused.length ? (
            <div className="mt-6 space-y-3">
              <h3 className="pdpp-title text-foreground">
                Not used in the last 30 days · {unused.length}
              </h3>
              <Text as="p">
                Don't recognise an app, or no longer use it? Remove its access. It keeps anything it already read.
              </Text>
              {choosing ? <div className="flex flex-wrap gap-2">
                <IcButton onClick={() => setSelected(unused.map(app=>app.hrefId))} variant="ghost">Tick all</IcButton>
                <IcButton onClick={() => {setChoosing(false);setSelected([]);setConfirm(false);}} variant="ghost">Cancel</IcButton>
                <IcButton disabled={!chosen.length || busy || confirm} onClick={() => setConfirm(true)} variant="destructive">Remove access for {chosen.length} apps</IcButton>
              </div> : <IcButton onClick={() => { setChoosing(true); setSelected([]); }} variant="ghost">Choose apps to remove</IcButton>}
              {confirm ? (
                <div
                  aria-label="Remove unused apps"
                  className="space-y-3 rounded-md border border-border p-3"
                  role="alertdialog"
                >
                  <Text as="p">Remove access for {chosen.length} apps?</Text>
                  <ul>{chosen.map(app=><li key={app.hrefId}>{app.name}{app.place && app.place !== "no address given" ? ` · ${app.place}` : ""} · {appSourceCount(app)} data source{appSourceCount(app)===1?"":"s"}</li>)}</ul>
                  <Text as="p">They keep anything they already read.</Text>
                  <IcButton disabled={busy} onClick={remove} variant="destructive">
                    Remove access for {chosen.length} apps
                  </IcButton>
                  <IcButton disabled={busy} onClick={() => setConfirm(false)} variant="ghost">
                    Cancel
                  </IcButton>
                </div>
              ) : null}
              {failed.length ? (
                <div className="text-destructive" role="alert">
                  <Text as="p">Access could not be removed for {failed.join(", ")}.</Text>
                  <IcButton disabled={busy} onClick={() => setConfirm(true)} variant="ghost">
                    Try again
                  </IcButton>
                </div>
              ) : null}
              {choosing ? <ul>{unused.filter(matches).map(app=><li className="flex items-center gap-3 py-3" key={app.hrefId}><input aria-label={`Remove ${app.name}`} checked={selected.includes(app.hrefId)} onChange={event=>setSelected(previous=>event.target.checked?[...previous,app.hrefId]:previous.filter(id=>id!==app.hrefId))} type="checkbox" value={app.hrefId} /><Text>{app.name}{app.place && app.place !== "no address given" ? ` · ${app.place}` : ""}</Text></li>)}</ul> : <AppAccessList apps={showAll ? unused.filter(matches) : unused.filter(matches).slice(0, 5)} demo={demo} />}
              {!(choosing || showAll ) && unused.filter(matches).length > 5 ? (
                <IcButton onClick={() => setShowAll(true)} variant="ghost">
                  Show all {unused.filter(matches).length}
                </IcButton>
              ) : null}
            </div>
          ) : null}
        </Section>
      ) : (
        <Section title="No app can read your data yet.">
          <Link className={buttonVariants()} href="/connect">
            Connect an app
          </Link>
        </Section>
      )}
      {stopped.length ? (
        <Section title="No longer have access">
          <AppAccessList apps={stopped} demo={demo} query={query} stopped />
        </Section>
      ) : null}
    </>
  );
}
