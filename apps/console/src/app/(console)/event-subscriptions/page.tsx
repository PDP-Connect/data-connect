// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator oversight surface for client event subscriptions.
 *
 * List + peek view backed by the `_ref/event-subscriptions*` routes. The
 * page renders the operator projection only — never the subscription
 * secret. The peek pane includes a single confirmed Disable affordance
 * that posts to a server action; there is no operator-create, re-enable,
 * rotate, or replay surface on purpose. The bound grant retains all
 * lifecycle authority.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import {
  Endorse,
  Eyebrow,
  IcButton,
  IcField,
  IcInput,
  IcSelect,
  KV,
  KVRow,
  Sheet,
  SheetBody,
  SheetHead,
  SheetTitle,
  Typed,
  TypedSm,
} from "@pdpp/brand-react";
import { EmptyState } from "@pdpp/operator-ui/components/empty-state";
import {
  DataList,
  FilterSummary,
  PageHeader,
  Section,
  SplitLayout,
  Toolbar,
  ToolbarField,
} from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { formatRelative } from "@pdpp/display";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  type ClientEventSubscriptionAttempt,
  type ClientEventSubscriptionDetail,
  type ClientEventSubscriptionStatus,
  type ClientEventSubscriptionSummary,
  getClientEventSubscription,
  listClientEventSubscriptions,
} from "../lib/ref-client.ts";
import { disableSubscriptionAction } from "./disable-action.ts";
import { subscriptionFailureSentence } from "./row-copy.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Webhooks",
};

function relativeTime(value: string | null | undefined): string {
  if (!value) {
    return "Time not available";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not available" : formatRelative(date, Date.now());
}

// Mirrors the SubscriptionStatus union on the server. Kept in one place so
// the row badge tone and the status filter options stay in lockstep.
// Maps subscription status to Endorse variants:
//   active             → active (green)
//   pending_verification → expiring (amber — waiting, owner attention)
//   disabled / disabled_failure / disabled_revoked → denied (red)
//   deleted            → revoked (muted/struck — soft-deleted, not erased)
function subscriptionEndorseStatus(
  status: ClientEventSubscriptionStatus
): "active" | "expiring" | "denied" | "revoked" {
  switch (status) {
    case "active":
      return "active";
    case "pending_verification":
      return "expiring";
    case "disabled":
    case "disabled_failure":
    case "disabled_revoked":
      return "denied";
    case "deleted":
      return "revoked";
    default:
      return "revoked";
  }
}

function subscriptionEndorseLabel(status: ClientEventSubscriptionStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "pending_verification":
      return "pending verification";
    case "disabled":
      return "disabled";
    case "disabled_failure":
      return "disabled · failure";
    case "disabled_revoked":
      return "disabled · revoked";
    case "deleted":
      return "deleted";
    default:
      return status;
  }
}

const STATUS_FILTER_OPTIONS: { label: string; value: ClientEventSubscriptionStatus }[] = [
  { label: "active", value: "active" },
  { label: "pending verification", value: "pending_verification" },
  { label: "disabled", value: "disabled" },
  { label: "disabled · failure", value: "disabled_failure" },
  { label: "disabled · revoked", value: "disabled_revoked" },
];

// Statuses for which the operator-disable form is hidden because the
// subscription is already not delivering. The set is a UI condition, not
// a lifecycle concept — three of these four statuses are recoverable by
// the bound client, and `DisabledNoticeCopy` below splits the copy per
// status to reflect the real state machine:
//
//   - `disabled`         — client may re-enable via PATCH { enabled: true }
//   - `disabled_failure` — same client re-enable path; cause was delivery
//                          failure rather than a client/operator disable
//   - `disabled_revoked` — grant was revoked; the client's re-enable PATCH
//                          is rejected with 409 grant_revoked; the only
//                          recovery is a new grant
//   - `deleted`          — soft-deleted; not recoverable
//
// Source of truth for those transitions lives in
// `reference-implementation/operations/as-client-event-subscriptions/`.
const HIDE_DISABLE_FORM_STATUSES = new Set<ClientEventSubscriptionStatus>([
  "disabled",
  "disabled_failure",
  "disabled_revoked",
  "deleted",
]);

interface PageParams {
  client_id?: string;
  disable_error?: string;
  grant_id?: string;
  peek?: string;
  status?: string;
}

interface ResolvedParams {
  clientId: string;
  disableError: string;
  grantId: string;
  peekId: string;
  status: string;
}

function resolveParams(params: PageParams): ResolvedParams {
  return {
    clientId: (params.client_id ?? "").trim(),
    disableError: (params.disable_error ?? "").trim(),
    grantId: (params.grant_id ?? "").trim(),
    peekId: (params.peek ?? "").trim(),
    status: (params.status ?? "").trim(),
  };
}

function buildListHref(params: ResolvedParams, overrides: Record<string, string | undefined> = {}): string {
  const search = new URLSearchParams();
  const setOrInherit = (key: string, inherited: string) => {
    if (key in overrides) {
      const v = overrides[key];
      if (v && v.length > 0) {
        search.set(key, v);
      }
    } else if (inherited) {
      search.set(key, inherited);
    }
  };
  setOrInherit("client_id", params.clientId);
  setOrInherit("grant_id", params.grantId);
  setOrInherit("status", params.status);
  setOrInherit("peek", params.peekId);
  const qs = search.toString();
  return qs ? `/event-subscriptions?${qs}` : "/event-subscriptions";
}

function activeFilterChips(params: ResolvedParams): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  if (params.clientId) {
    chips.push({ label: "app", value: params.clientId });
  }
  if (params.grantId) {
    chips.push({ label: "access", value: params.grantId });
  }
  if (params.status) {
    chips.push({ label: "status", value: params.status });
  }
  return chips;
}

function renderPeek({
  disableError,
  peek,
  peekId,
}: {
  disableError: string;
  peek: ClientEventSubscriptionDetail | null;
  peekId: string;
}): ReactNode {
  if (!peekId) {
    return (
      <Section title="Choose a webhook">
        <p className="pdpp-body text-muted-foreground">
          Choose a row to see its address and recent deliveries.
        </p>
      </Section>
    );
  }
  if (!peek) {
    return (
      <Section title="Webhook not found">
        <p className="pdpp-body text-muted-foreground">
          This webhook is no longer available.
        </p>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer">Details</summary>
          <Typed as="code">{peekId}</Typed>
        </details>
        <p className="pdpp-body mt-3">
          <Link className="underline-offset-2 hover:underline" href="/event-subscriptions">
            ← Back to webhooks
          </Link>
        </p>
      </Section>
    );
  }
  return <PeekPane disableError={disableError} subscription={peek} />;
}

export default async function EventSubscriptionsPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = resolveParams(await searchParams);

  try {
    const list = await listClientEventSubscriptions({
      client_id: params.clientId || undefined,
      grant_id: params.grantId || undefined,
      status: params.status || undefined,
    });
    const hasFilters = Boolean(params.clientId || params.grantId || params.status);

    const peek = params.peekId
      ? await getClientEventSubscription(params.peekId).catch((err) => {
          // Don't fail the whole page if the peek target is gone — render the
          // list with a PeekMissing state instead.
          if (err instanceof ReferenceServerUnreachableError) {
            throw err;
          }
          return null;
        })
      : null;

    return (
      <RecordroomShellWithPalette>
        <PageHeader
          count={`${list.data.length}`}
          description="Send a message to your own address when something changes."
          title="Webhooks"
        />

        <FiltersForm params={params} />
        <FilterSummary items={activeFilterChips(params)} resetHref="/event-subscriptions" />

        <SplitLayout
          main={
            list.data.length === 0 ? (
              <EmptyState
                hint={
                  hasFilters
                    ? "Change a filter or clear them."
                    : "An app adds a webhook here when it asks to hear about changes."
                }
                title={hasFilters ? "No webhooks match these filters" : "No webhooks yet"}
              />
            ) : (
              <DataList ariaLabel="Webhooks">
                {list.data.map((sub) => (
                  <SubscriptionRow
                    href={buildListHref(params, { peek: sub.subscription_id })}
                    key={sub.subscription_id}
                    peeked={sub.subscription_id === params.peekId}
                    subscription={sub}
                  />
                ))}
              </DataList>
            )
          }
          peek={renderPeek({ disableError: params.disableError, peek, peekId: params.peekId })}
        />
      </RecordroomShellWithPalette>
    );
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }
}

function FiltersForm({ params }: { params: ResolvedParams }) {
  return (
    <form action="/event-subscriptions" className="mb-3 flex flex-wrap items-center gap-2" method="get">
      {/* Preserve the active peek across filter submits so the operator
          can keep a row open while narrowing the surrounding list. */}
      {params.peekId ? <input name="peek" type="hidden" value={params.peekId} /> : null}
      <Toolbar>
        <ToolbarField label="App" width="min-w-0">
          <IcInput defaultValue={params.clientId} name="client_id" placeholder="App" />
        </ToolbarField>
        <ToolbarField label="Access" width="min-w-0">
          <IcInput defaultValue={params.grantId} name="grant_id" placeholder="Access" />
        </ToolbarField>
        <ToolbarField label="Status" width="min-w-0">
          <IcSelect
            defaultValue={params.status}
            name="status"
            options={[{ label: "Any status", value: "" }, ...STATUS_FILTER_OPTIONS]}
          />
        </ToolbarField>
        <IcButton size="sm" type="submit" variant="ghost">
          Filter
        </IcButton>
      </Toolbar>
    </form>
  );
}

function SubscriptionRow({
  subscription,
  href,
  peeked,
}: {
  subscription: ClientEventSubscriptionSummary;
  href: string;
  peeked: boolean;
}) {
  const detailHref = `/event-subscriptions/${encodeURIComponent(subscription.subscription_id)}`;
  const failureSentence = subscriptionFailureSentence(subscription);

  const rowContent = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <Typed as="span" className="block truncate font-medium">{subscription.callback_host}</Typed>
          <TypedSm className="block truncate text-muted-foreground">Open to see what it listens for</TypedSm>
          {failureSentence ? <TypedSm className="block text-destructive">{failureSentence}</TypedSm> : null}
        </span>
        <div className="flex items-center gap-2">
          <Endorse
            label={subscriptionEndorseLabel(subscription.status)}
            status={subscriptionEndorseStatus(subscription.status)}
          />
          <TypedSm className="text-muted-foreground">
            {subscription.last_attempted_at ? (
              <>Last delivery {relativeTime(subscription.last_attempted_at)}</>
            ) : (
              "No delivery yet"
            )}
          </TypedSm>
        </div>
      </div>
    </>
  );

  return (
    <li>
      <div
        aria-current={peeked ? "true" : undefined}
        className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
      >
        {/* Mobile (below xl): navigate to full-page detail route. */}
        <Link className="block xl:hidden" href={detailHref}>
          {rowContent}
        </Link>
        {/* Desktop (xl+): open the side-panel peek via ?peek= param. */}
        <Link className="hidden xl:block" href={href} scroll={false}>
          {rowContent}
        </Link>
        <details className="pdpp-caption mt-2 text-muted-foreground">
          <summary className="cursor-pointer text-foreground">Details</summary>
          <div className="mt-1 grid gap-1">
            <span>App <Typed as="code">{subscription.client_id}</Typed> · Access <Typed as="code">{subscription.grant_id}</Typed></span>
            <span>Waiting to send {subscription.pending_queue_count} · Failed deliveries {subscription.final_failure_count}</span>
            <span>Updated {relativeTime(subscription.updated_at)}</span>
            <LastAttemptCell subscription={subscription} />
          </div>
        </details>
      </div>
    </li>
  );
}

function LastAttemptCell({ subscription }: { subscription: ClientEventSubscriptionSummary }) {
  if (!subscription.last_attempted_at) {
    return <span>No deliveries yet</span>;
  }
  const okLabel = subscription.last_attempt_ok ? "Delivered" : "Delivery failed";
  const code = subscription.last_attempt_status_code ?? "—";
  return (
    <span>
      {okLabel} · {relativeTime(subscription.last_attempted_at)} · {code}
    </span>
  );
}

function PeekPane({
  subscription,
  disableError,
}: {
  subscription: ClientEventSubscriptionDetail;
  disableError: string;
}) {
  const hideDisableForm = HIDE_DISABLE_FORM_STATUSES.has(subscription.status);
  return (
    <Sheet>
      <SheetHead>
        <div className="flex flex-wrap items-baseline gap-2">
          <SheetTitle>{subscription.callback_host}</SheetTitle>
          <Endorse
            label={subscriptionEndorseLabel(subscription.status)}
            status={subscriptionEndorseStatus(subscription.status)}
          />
        </div>
      </SheetHead>
      <SheetBody>
        <KV className="mb-4">
          <KVRow k="Address">
            <Typed as="code" className="break-all">
              {subscription.callback_url}
            </Typed>
          </KVRow>
          <KVRow k="What it listens for">{describeScope(subscription.scope)}</KVRow>
          <KVRow k="Last delivery">
            {subscription.last_attempted_at ? relativeTime(subscription.last_attempted_at) : "No delivery yet"}
          </KVRow>
        </KV>

        <details className="mb-4">
          <summary className="cursor-pointer">Details</summary>
          <div className="pt-3">
            <KV>
              <KVRow k="Webhook"><Typed as="code">{subscription.subscription_id}</Typed></KVRow>
              <KVRow k="App"><Typed as="code">{subscription.client_id}</Typed></KVRow>
              <KVRow k="Access">
                <Link className="underline-offset-2 hover:underline" href={dashboardRoutes.grant(subscription.grant_id)}>
                  <Typed as="code">{subscription.grant_id}</Typed>
                </Link>
              </KVRow>
              <KVRow k="Created">{relativeTime(subscription.created_at)}</KVRow>
              <KVRow k="Updated">{relativeTime(subscription.updated_at)}</KVRow>
              {subscription.disabled_at ? (
                <KVRow k="Turned off">
                  {relativeTime(subscription.disabled_at)}
                  {subscription.disabled_reason ? (
                    <details className="ml-2">
                      <summary className="cursor-pointer">Details</summary>
                      <Typed as="code">{subscription.disabled_reason}</Typed>
                    </details>
                  ) : null}
                </KVRow>
              ) : null}
              <KVRow k="Waiting to send">{subscription.pending_queue_count}</KVRow>
              <KVRow k="Failed deliveries">{subscription.final_failure_count}</KVRow>
            </KV>
            {hideDisableForm ? <DisabledNoticeCopy status={subscription.status} subscriptionId={subscription.subscription_id} /> : null}
          </div>
        </details>

        {hideDisableForm ? null : <DisableForm disableError={disableError} subscriptionId={subscription.subscription_id} />}

        <RecentAttempts attempts={subscription.recent_attempts} />
      </SheetBody>
    </Sheet>
  );
}

// Per-status copy for the "Disable form is hidden because the row is
// already not delivering" notice. Three of the four statuses are
// recoverable by the bound client; one (`disabled_revoked`) is not, and
// `deleted` is not recoverable at all. See the operations layer in
// `reference-implementation/operations/as-client-event-subscriptions/`
// for the real transitions.
function DisabledNoticeCopy({
  status,
  subscriptionId,
}: {
  status: ClientEventSubscriptionStatus;
  subscriptionId: string;
}) {
  const clientReenablePatch = (
    <Typed as="code">
      PATCH /v1/event-subscriptions/{subscriptionId} {"{ enabled: true }"}
    </Typed>
  );
  const reenableDetails = (
    <details className="pdpp-caption mt-1">
      <summary className="cursor-pointer">Details</summary>
      <p>The app can turn it back on by sending {clientReenablePatch} from its own account.</p>
    </details>
  );
  if (status === "disabled") {
    return (
      <div className="mt-4 text-muted-foreground">
        <p>This webhook is already off. The app can turn it back on from its own account.</p>
        {reenableDetails}
      </div>
    );
  }
  if (status === "disabled_failure") {
    return (
      <div className="mt-4 text-muted-foreground">
        <p>This webhook was turned off after repeated delivery failures. The app can turn it back on after fixing the address.</p>
        {reenableDetails}
      </div>
    );
  }
  if (status === "disabled_revoked") {
    return (
      <div className="mt-4 text-muted-foreground">
        <p>This webhook cannot be turned back on because its access was removed. The app needs new access and a new webhook.</p>
        <details className="pdpp-caption mt-1">
          <summary className="cursor-pointer">Details</summary>
          <p>
            The re-enable request is rejected with <Typed as="code">409 grant_revoked</Typed>. The app must obtain new
            access and create a new webhook.
          </p>
        </details>
      </div>
    );
  }
  // status === "deleted"
  return (
    <p className="mt-4 text-muted-foreground">This webhook was deleted and cannot be turned back on. The app needs to create another webhook with active access.</p>
  );
}

function DisableForm({ subscriptionId, disableError }: { subscriptionId: string; disableError: string }) {
  // The Disable affordance is intentionally a server-rendered two-input
  // form: a `confirm_disable` checkbox the operator must tick and the
  // submit button. The server action rejects submits that are missing
  // the checkbox, so the confirmation is enforced server-side rather than
  // through a client-only `confirm()` dialog (per spec scenario "An
  // operator opens the peek pane and disables a subscription").
  return (
    <form action={disableSubscriptionAction} className="mt-4 flex flex-col gap-2">
      <input name="subscription_id" type="hidden" value={subscriptionId} />
      <input name="return_to" type="hidden" value="list" />
      <IcField htmlFor={`reason-${subscriptionId}`} label="Reason (optional)">
        <IcInput defaultValue="" id={`reason-${subscriptionId}`} name="reason" placeholder="Repeated messages" />
      </IcField>
      <details className="pdpp-caption">
        <summary className="cursor-pointer">Details</summary>
        <p>Max 256 bytes (UTF-8).</p>
      </details>
      <label
        className="pdpp-caption mt-1 flex items-center gap-2 text-muted-foreground"
        htmlFor={`confirm-${subscriptionId}`}
      >
        <input id={`confirm-${subscriptionId}`} name="confirm_disable" required type="checkbox" value="yes" />
        <span>
          I understand this stops messages to this address. The app can turn them back on.
        </span>
      </label>
      {disableError ? (
        <div>
          <p className="pdpp-caption text-destructive" role="alert">Could not turn off this webhook. Try again.</p>
          <details className="pdpp-caption">
            <summary className="cursor-pointer">Details</summary>
            <p>{disableError}</p>
          </details>
        </div>
      ) : null}
      <IcButton size="sm" type="submit" variant="destructive">
        Turn off webhook
      </IcButton>
    </form>
  );
}

function RecentAttempts({ attempts }: { attempts: ClientEventSubscriptionAttempt[] }) {
  if (attempts.length === 0) {
    return <p className="pdpp-caption mt-4 text-muted-foreground">No deliveries yet.</p>;
  }
  return (
    <div className="mt-5">
      <Eyebrow as="h3" className="mb-2">
        Deliveries
      </Eyebrow>
      <ol className="pdpp-caption divide-y divide-border/70 border-border/70 border-y">
        {attempts.map((attempt) => (
          <li className="flex flex-wrap items-baseline justify-between gap-2 px-1 py-1.5" key={attempt.attempt_id}>
            <Typed as="span">{attempt.ok ? "Delivered" : "Failed"}</Typed>
            <TypedSm className="text-muted-foreground">{relativeTime(attempt.attempted_at)}</TypedSm>
            <details>
              <summary className="cursor-pointer">Details</summary>
              <span className="text-muted-foreground">
                {attempt.event_type} · {attempt.status_code === null ? "No response code" : `Response ${attempt.status_code}`} ·{" "}
                {attempt.latency_ms === null ? "Time unavailable" : `${attempt.latency_ms}ms`}
                {attempt.error ? ` · ${attempt.error}` : ""}
              </span>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}

function describeScope(scope: ClientEventSubscriptionDetail["scope"]): ReactNode {
  if (!scope) {
    return "—";
  }
  const streams = Array.isArray(scope.streams)
    ? scope.streams.map((s) => s?.name).filter((n): n is string => typeof n === "string" && n.length > 0)
    : [];
  if (streams.length === 0) {
    return "—";
  }
  return <span>Changes to {streams.join(", ")}</span>;
}
