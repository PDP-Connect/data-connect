// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { Menu } from "@base-ui/react/menu";
import { buttonVariants, IcButton, Text } from "@pdpp/brand-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useState, useTransition } from "react";
import { ConnectorMark } from "../components/connector-mark.tsx";
import type { RunNowResult } from "./actions.ts";
import { SourceRowStatus } from "./source-row-status.tsx";
import type { DuplicateSourceReview, SourceInstanceView, SourcesRuntimeAdvisory } from "./sources-view-model.ts";
import { buildDuplicateSourceReview, collapseSetupFailedSources, filterSourcesForList, orderSourcesForList, reactivateRecordCopy, sourceRowMenuItems } from "./sources-view-model.ts";
import { UpdatesReadySlot } from "./updates-ready.tsx";
import type { UpdatesReadyModel } from "./updates-ready-model.ts";
import "./sources-view.css";

interface SourcesViewProps {
  instances: SourceInstanceView[];
  interactive: boolean;
  pagingInPlay?: boolean;
  reactivateAction: FormAction;
  resumeAction: FormAction;
  resumeScheduleAction: FormAction;
  resumeSetupAction: FormAction;
  revokeAction: FormAction;
  runNowAction: RunNowAction;
  runtimeAdvisory?: SourcesRuntimeAdvisory | null;
  updatesReady?: Promise<UpdatesReadyModel | null>;
  updatesReadyDemo?: { initialResult: string | null; model: UpdatesReadyModel };
}

type ToastState =
  | { kind: "none" }
  | { kind: "ok"; message: string; syncHref?: string }
  | { kind: "error"; message: string };

type FormAction = (formData: FormData) => void | Promise<void>;
type RunNowAction = (connectorId: string, connectionId?: string | null) => Promise<RunNowResult>;

export function SourcesView({
  instances,
  interactive,
  pagingInPlay = false,
  reactivateAction,
  resumeAction,
  resumeScheduleAction,
  resumeSetupAction,
  revokeAction,
  runNowAction,
  runtimeAdvisory,
  updatesReady,
  updatesReadyDemo,
}: SourcesViewProps) {
  const [query, setQuery] = useState("");
  const archived = instances.filter((instance) => instance.archived);
  const disconnected = instances.filter((instance) => instance.revoked && !instance.archived && !instance.setupFailed);
  const setupNotCompleted = collapseSetupFailedSources(instances).setupFailedGroups.map((group) => group.representative);
  const listRows = orderSourcesForList(instances.filter((instance) =>
    !instance.archived && !instance.revoked && !instance.setupFailed
  ));
  const filteredRows = filterSourcesForList(listRows, query);
  const showFilter = listRows.length > 10;
  // Nothing is connected: the disconnected group is the page, so it starts open.
  const onlyDisconnected = listRows.length === 0 && disconnected.length > 0;

  if (instances.length === 0 && !pagingInPlay) {
    return (
      <section className="rr-s-empty" data-testid="sources-empty">
        <Text as="p">No data sources yet.</Text>
      </section>
    );
  }

  return (
    <>
      {updatesReady || updatesReadyDemo ? (
        <Suspense fallback={null}>
          <UpdatesReadySlot
            demoModel={updatesReadyDemo?.model}
            initialResult={updatesReadyDemo?.initialResult}
            interactive={interactive}
            updates={updatesReady}
          />
        </Suspense>
      ) : null}
      {runtimeAdvisory ? <RuntimeNotice advisory={runtimeAdvisory} /> : null}
      {buildDuplicateNotice(buildDuplicateSourceReview(instances.filter((instance) => !(instance.archived || instance.setupFailed))))}

      <section aria-label="Data sources" className="rr-s" data-testid="sources-list">
        {showFilter ? (
          <div className="rr-s-filter">
            <label className="sr-only" htmlFor="sources-filter">Filter data sources</label>
            <input
              autoComplete="off"
              className="rr-s-filter__input"
              id="sources-filter"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Filter by name or account"
              type="search"
              value={query}
            />
            {pagingInPlay ? (
              <Text as="p" className="rr-s-filter__note" color="muted">
                Filtering the {listRows.length.toLocaleString()} data sources on this page.
              </Text>
            ) : null}
          </div>
        ) : null}

        <div className="rr-s-columns" aria-hidden="true">
          <span>Data source</span><span>Status</span><span className="rr-s-columns__records">Records</span><span>Schedule</span><span /><span />
        </div>
        <ul className="rr-s-list">
          {filteredRows.map((instance) => (
            <SourceRow
              instance={instance}
              interactive={interactive}
              key={instance.id}
              reactivateAction={reactivateAction}
              resumeAction={resumeAction}
              resumeScheduleAction={resumeScheduleAction}
              resumeSetupAction={resumeSetupAction}
              revokeAction={revokeAction}
              runNowAction={runNowAction}
            />
          ))}
          {filteredRows.length === 0 ? (
            <li className="rr-s-no-results">
              {query ? "No data sources match that filter." : onlyDisconnected ? `No connected data sources. ${disconnected.length.toLocaleString()} ${disconnected.length === 1 ? "is" : "are"} disconnected.` : "No data sources on this page."}
            </li>
          ) : null}
        </ul>

      <FoldedGroup open={onlyDisconnected} instances={disconnected} interactive={interactive} reactivateAction={reactivateAction} resumeAction={resumeAction} resumeScheduleAction={resumeScheduleAction} resumeSetupAction={resumeSetupAction} revokeAction={revokeAction} runNowAction={runNowAction} label="Disconnected" note="These data sources are disconnected. Their records stay available. Set up again to start collecting again." />
      <FoldedGroup instances={archived} interactive={interactive} reactivateAction={reactivateAction} resumeAction={resumeAction} resumeScheduleAction={resumeScheduleAction} resumeSetupAction={resumeSetupAction} revokeAction={revokeAction} runNowAction={runNowAction} label="Archived" note="These data sources no longer sync. Their records stay available." />
      <FoldedGroup instances={setupNotCompleted} interactive={interactive} reactivateAction={reactivateAction} resumeAction={resumeAction} resumeScheduleAction={resumeScheduleAction} resumeSetupAction={resumeSetupAction} revokeAction={revokeAction} runNowAction={runNowAction} label="Setup never completed" note="These setup attempts did not finish. No records were collected. Continue setup to try again." />
      </section>
    </>
  );
}

function SourceRow({
  instance,
  interactive,
  reactivateAction,
  resumeAction,
  resumeScheduleAction,
  resumeSetupAction,
  revokeAction,
  runNowAction,
}: {
  instance: SourceInstanceView;
  interactive: boolean;
  reactivateAction: FormAction;
  resumeAction: FormAction;
  resumeScheduleAction: FormAction;
  resumeSetupAction: FormAction;
  revokeAction: FormAction;
  runNowAction: RunNowAction;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<ToastState>({ kind: "none" });
  const startSync = useCallback((reprocess = false) => {
    setToast({ kind: "none" });
    startTransition(async () => {
      const result = await runNowAction(
        instance.connectorId,
        instance.connectionId ?? instance.connectorInstanceId ?? null
      );
      if (result.ok) {
        setToast({
          kind: "ok",
          message: reprocess ? "Reprocessing all exports started." : "Sync started.",
          syncHref: result.run_id ? `/syncs/${encodeURIComponent(result.run_id)}` : undefined,
        });
        router.refresh();
      } else if (result.reason === "already_running") {
        setToast({ kind: "ok", message: result.message, syncHref: result.run_id ? `/syncs/${encodeURIComponent(result.run_id)}` : undefined });
        router.refresh();
      } else {
        setToast({ kind: "error", message: result.reason === "connector_not_installed"
          ? "This data source needs its collector installed before it can sync. Open the data source to install it."
          : result.message });
      }
    });
  }, [instance.connectionId, instance.connectorId, instance.connectorInstanceId, router, runNowAction]);
  return (
    <li className="rr-s-row" data-source-row={instance.id}>
      <Link aria-label={`Open ${instance.displayName}`} className="rr-s-row__link" href={instance.detailHref}>
        <span className="rr-s-row__source">
          <span className="rr-s-row__logo">
            <ConnectorMark connectorId={instance.connectorId} icon={instance.icon} name={instance.displayName} />
          </span>
          <span className="rr-s-row__identity">
            <Text as="span" className="rr-s-row__name" size="small" weight="medium">{instance.displayName}</Text>
            {instance.listKind ? <Text as="span" className="rr-s-row__kind" color="muted" size="small">{instance.listKind}</Text> : null}
          </span>
        </span>
        <SourceRowStatus instance={instance} />
        <span className="rr-s-row__records">{instance.recordsLabel}</span>
        <span className="rr-s-row__schedule">{instance.scheduleLabel}</span>
      </Link>
      <RowAction
        instance={instance}
        interactive={interactive}
        pending={pending}
        onSync={() => startSync()}
        resumeAction={resumeAction}
        resumeScheduleAction={resumeScheduleAction}
        resumeSetupAction={resumeSetupAction}
      />
      <SourceRowMenu
        instance={instance}
        interactive={interactive}
        pending={pending}
        onSync={() => startSync()}
        onReprocess={() => startSync(true)}
        reactivateAction={reactivateAction}
        revokeAction={revokeAction}
      />
      {toast.kind !== "none" ? (
        <p aria-live="polite" className="rr-s-row__toast" data-tone={toast.kind} role="status">
          {toast.message}{toast.kind === "ok" && toast.syncHref ? <> <Link href={toast.syncHref}>See this sync</Link></> : null}
          {pending ? " Starting…" : null}
        </p>
      ) : null}
    </li>
  );
}

function RowAction({ instance, interactive, pending, onSync, resumeAction, resumeScheduleAction, resumeSetupAction }: {
  instance: SourceInstanceView;
  interactive: boolean;
  pending: boolean;
  onSync: () => void;
  resumeAction: FormAction;
  resumeScheduleAction: FormAction;
  resumeSetupAction: FormAction;
}) {
  const action = instance.statusWords.action;

  if (!action) return null;
  // DIRECTION.md, Values: on list rows the row's button is outlined; the page's one filled button is "Add a data source".
  const variant = "ghost";
  if (action.kind === "sync_now" || action.kind === "retry_first_sync") {
    return (
      <IcButton className="rr-s-row__action" disabled={!interactive || pending || instance.isRunning} onClick={onSync} size="sm" type="button" variant={variant}>
        {pending ? "Starting…" : action.label}
      </IcButton>
    );
  }
  if (action.kind === "resume" && instance.connectionId) {
    return (
      <form action={resumeAction} className="rr-s-row__action-form">
        <input name="connection_id" type="hidden" value={instance.connectionId} />
        <IcButton disabled={!interactive} size="sm" type="submit" variant={variant}>{action.label}</IcButton>
      </form>
    );
  }
  if (action.kind === "server_cta" && instance.primaryVerdictAction?.kind === "reattach_schedule" && instance.connectionId) {
    return (
      <form action={resumeScheduleAction} className="rr-s-row__action-form">
        <input name="connector_id" type="hidden" value={instance.connectorId} />
        <input name="connection_id" type="hidden" value={instance.connectionId} />
        <IcButton disabled={!interactive} size="sm" type="submit" variant={variant}>{action.label}</IcButton>
      </form>
    );
  }
  if (action.kind === "continue_setup" && instance.setupFailed && instance.connectionId) {
    return (
      <form action={resumeSetupAction} className="rr-s-row__action-form">
        <input name="connection_id" type="hidden" value={instance.connectionId} />
        <IcButton disabled={!interactive} size="sm" type="submit" variant={variant}>{action.label}</IcButton>
      </form>
    );
  }
  if (action.kind === "server_cta" && instance.codeEntryHref) {
    return <Link className={`${buttonVariants({ size: "sm", variant })} rr-s-row__action`} href={instance.codeEntryHref}>{action.label}</Link>;
  }
  if (action.kind === "set_up_again") {
    return (
      <Link className={`${buttonVariants({ size: "sm", variant })} rr-s-row__action`} href={`/sources/add?source_q=${encodeURIComponent(instance.connectorId)}`}>
        {action.label}
      </Link>
    );
  }
  if (action.kind === "server_cta" && instance.primaryVerdictAction?.ownerRunnable &&
      (instance.primaryVerdictAction.kind === "refresh_now" || instance.primaryVerdictAction.kind === "retry_gap")) {
    return (
      <IcButton className="rr-s-row__action" disabled={!interactive || pending || instance.isRunning} onClick={onSync} size="sm" type="button" variant={variant}>
        {pending ? "Starting…" : action.label}
      </IcButton>
    );
  }
  return (
    <Link className={`${buttonVariants({ size: "sm", variant })} rr-s-row__action`} href={instance.detailHref}>
      {action.label}
    </Link>
  );
}

function SourceRowMenu({ instance, interactive, pending, onSync, onReprocess, reactivateAction, revokeAction }: {
  instance: SourceInstanceView;
  interactive: boolean;
  pending: boolean;
  onSync: () => void;
  onReprocess: () => void;
  reactivateAction: FormAction;
  revokeAction: FormAction;
}) {
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [confirmingReactivate, setConfirmingReactivate] = useState(false);
  const menuItems = sourceRowMenuItems(instance, interactive);

  return (
    <>
      <Menu.Root>
        <Menu.Trigger aria-label={`More actions for ${instance.displayName}`} className="rr-s-menu-trigger" type="button">…</Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="rr-s-menu-positioner" sideOffset={6}>
            <Menu.Popup className="rr-s-menu">
              {menuItems.slice(0, -1).map((item) => {
                if (item.kind === "sync") {
                  return <Menu.Item className="rr-s-menu__item" disabled={!interactive || pending} key={item.kind} onClick={onSync}>{item.label}</Menu.Item>;
                }
                if (item.kind === "add_export") {
                  return <Menu.LinkItem className="rr-s-menu__item" closeOnClick href={item.href} key={item.kind}>{item.label}</Menu.LinkItem>;
                }
                if (item.kind === "reprocess") {
                  return <Menu.Item className="rr-s-menu__item" disabled={!interactive || pending || instance.isRunning || instance.revoked} key={item.kind} onClick={onReprocess}>{item.label}</Menu.Item>;
                }
                if (item.kind === "revoke") {
                  return <Menu.Item className="rr-s-menu__item" key={item.kind} onClick={() => setConfirmingRevoke(true)}>{item.label}</Menu.Item>;
                }
                return <Menu.Item className="rr-s-menu__item" key={item.kind} onClick={() => setConfirmingReactivate(true)}>{item.label}</Menu.Item>;
              })}
              {menuItems.length > 1 ? <Menu.Separator className="rr-s-menu__separator" /> : null}
              <Menu.LinkItem className="rr-s-menu__item" closeOnClick href={instance.detailHref}>{menuItems.at(-1)?.label}</Menu.LinkItem>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {confirmingRevoke && instance.connectionId ? (
        <RevokeCeremony action={revokeAction} connectionId={instance.connectionId} onCancel={() => setConfirmingRevoke(false)} />
      ) : null}
      {confirmingReactivate && instance.connectionId ? (
        <ReactivateCeremony action={reactivateAction} connectionId={instance.connectionId} instance={instance} onCancel={() => setConfirmingReactivate(false)} />
      ) : null}
    </>
  );
}

function RevokeCeremony({ action, connectionId, onCancel }: { action: FormAction; connectionId: string; onCancel: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <form action={action} className="rr-s-confirm" data-testid="sources-revoke-ceremony">
      <input name="connection_id" type="hidden" value={connectionId} />
      <p>Revoke stops future collection for this data source and signs out its saved browser session. Already-collected records, app access, and activity history stay.</p>
      <label><input checked={confirmed} name="confirm_revoke" onChange={(event) => setConfirmed(event.currentTarget.checked)} type="checkbox" value="yes" /> Stop future collection for this data source; keep its records.</label>
      <div className="rr-s-confirm__actions">
        <IcButton onClick={onCancel} size="sm" type="button" variant="ghost">Keep</IcButton>
        <IcButton disabled={!confirmed} size="sm" type="submit" variant="destructive">Confirm revoke</IcButton>
      </div>
    </form>
  );
}

function ReactivateCeremony({
  connectionId,
  action,
  instance,
  onCancel,
}: {
  connectionId: string;
  action: FormAction;
  instance: SourceInstanceView;
  onCancel: () => void;
}) {
  const records = reactivateRecordCopy(instance.totalRecords, instance.totalRecordsState);
  const signInNote = instance.status.kind === "revoked" && instance.revoked
    ? " If your saved sign-in details have expired, the next sync may ask you to update them."
    : "";
  return (
    <form action={action} aria-label="Confirm reactivate" className="rr-s-confirm" data-testid="sources-reactivate-ceremony">
      <input name="connection_id" type="hidden" value={connectionId} />
      <p>Reactivate resumes collection for this data source. Your {records} preserved; nothing is erased. Collection resumes on the next scheduled sync.{signInNote}</p>
      <div className="rr-s-confirm__actions">
        <IcButton onClick={onCancel} size="sm" type="button" variant="ghost">Cancel</IcButton>
        <IcButton size="sm" type="submit">Reactivate</IcButton>
      </div>
    </form>
  );
}

function FoldedGroup({ instances, interactive, open = false, reactivateAction, resumeAction, resumeScheduleAction, resumeSetupAction, revokeAction, runNowAction, label, note }: {
  instances: SourceInstanceView[];
  open?: boolean;
  interactive: boolean;
  reactivateAction: FormAction;
  resumeAction: FormAction;
  resumeScheduleAction: FormAction;
  resumeSetupAction: FormAction;
  revokeAction: FormAction;
  runNowAction: RunNowAction;
  label: string;
  note: string;
}) {
  if (instances.length === 0) return null;
  return (
    <details className="rr-s-folded" open={open}>
      <summary>{label} · {instances.length.toLocaleString()}</summary>
      <Text as="p" className="rr-s-folded__note" color="muted">{note}</Text>
      <ul className="rr-s-folded__list">
        {instances.map((instance) => (
          <SourceRow
            instance={instance}
            interactive={interactive}
            key={instance.id}
            reactivateAction={reactivateAction}
            resumeAction={resumeAction}
            resumeScheduleAction={resumeScheduleAction}
            resumeSetupAction={resumeSetupAction}
            revokeAction={revokeAction}
            runNowAction={runNowAction}
          />
        ))}
      </ul>
    </details>
  );
}

function RuntimeNotice({ advisory }: { advisory: SourcesRuntimeAdvisory }) {
  return <aside className="rr-s-notice" data-testid="sources-runtime-advisory" role="status"><Text as="p">{advisory.headline}</Text><Text as="p" color="muted">{advisory.note}</Text></aside>;
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

export function buildDuplicateNotice(reviews: readonly DuplicateSourceReview[]) {
  const primary = reviews[0];
  if (!primary) return null;
  const total = COUNT_WORDS[primary.total] ?? primary.total.toLocaleString();
  return (
    <aside className="rr-s-notice" data-testid="sources-duplicate-review" role="note">
      <Text as="p">You have {total} {primary.kind} accounts.</Text>
      <Text as="p" color="muted">Name them so you can tell them apart.</Text>
      <Link className="rr-s-notice__link" href={primary.firstUnnamedHref}>Name them →</Link>
    </aside>
  );
}
