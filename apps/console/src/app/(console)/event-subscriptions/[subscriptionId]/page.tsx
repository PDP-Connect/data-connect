// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Full-page detail route for a single client event subscription.
 *
 * Mobile entry point: on screens narrower than `xl` (1280 px) the list
 * page rows navigate here instead of opening the side-panel peek. Desktop
 * still uses the `?peek=` SplitLayout; this page is also deep-linkable
 * and a browser-back target for mobile users.
 *
 * Content mirrors the peek pane in the list page — same KV metadata, same
 * disable form, same recent-attempts list — but rendered full-width with a
 * back link to the list. The shared `disableSubscriptionAction` server action
 * (defined in `../disable-action.ts`) redirects back to this page (not to
 * the list) when the form posts `return_to=detail`, so the operator sees the
 * updated state after disabling.
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
  KV,
  KVRow,
  Sheet,
  SheetBody,
  SheetHead,
  SheetSerial,
  SheetTitle,
  Typed,
  TypedSm,
} from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { formatRelative } from "@pdpp/display";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/server-unreachable.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import {
  type ClientEventSubscriptionAttempt,
  type ClientEventSubscriptionDetail,
  type ClientEventSubscriptionStatus,
  getClientEventSubscription,
} from "../../lib/ref-client.ts";
import { disableSubscriptionAction } from "../disable-action.ts";

export const dynamic = "force-dynamic";

// ─── Status helpers (mirrors list page) ──────────────────────────────────────

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

// Statuses for which the operator-disable form is hidden because the
// subscription is already not delivering. Three of these four are
// recoverable by the bound client via PATCH { enabled: true }.
const HIDE_DISABLE_FORM_STATUSES = new Set<ClientEventSubscriptionStatus>([
  "disabled",
  "disabled_failure",
  "disabled_revoked",
  "deleted",
]);

// ─── Scope description ────────────────────────────────────────────────────────

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
  return `Changes to ${streams.join(", ")}`;
}

function relativeTime(value: string | null | undefined): string {
  if (!value) {
    return "Time not available";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not available" : formatRelative(date, Date.now());
}

// ─── Per-status copy for disabled subscriptions ───────────────────────────────

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
  let message: string;
  switch (status) {
    case "disabled":
      message = "This webhook is off. The app can turn it on again.";
      break;
    case "disabled_failure":
      message = "This webhook stopped after repeated delivery failures. The app can turn it on again after the address works.";
      break;
    case "disabled_revoked":
      message = "This webhook cannot be turned on again because the app's access was removed. The app needs new access and a new webhook.";
      break;
    default:
      message = "This webhook was removed and cannot be turned on again.";
  }
  const reenableDetails =
    status === "disabled_revoked" ? (
      <>
        The app cannot re-enable this webhook with <Typed as="code">PATCH /v1/event-subscriptions/{subscriptionId} &#123; enabled: true &#125;</Typed> because access was removed (409 grant_revoked).
      </>
    ) : (
      <>The app can re-enable this webhook with {clientReenablePatch} from its own credentials.</>
    );
  return (
    <div className="mt-4">
      <p className="pdpp-caption text-muted-foreground">{message}</p>
      {status === "deleted" ? null : (
        <details className="pdpp-caption mt-2">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1 text-muted-foreground">
            {reenableDetails}
          </p>
        </details>
      )}
    </div>
  );
}

// ─── Disable form ─────────────────────────────────────────────────────────────

function DisableForm({ subscriptionId, disableError }: { subscriptionId: string; disableError: string }) {
  return (
    <form action={disableSubscriptionAction} className="mt-4 flex flex-col gap-2">
      <input name="subscription_id" type="hidden" value={subscriptionId} />
      <input name="return_to" type="hidden" value="detail" />
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
        <span>This stops messages to this address; the app can turn them back on.</span>
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

// ─── Recent attempts ──────────────────────────────────────────────────────────

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
              <div>
                {attempt.event_type} · {attempt.status_code === null ? "No response code" : `Response ${attempt.status_code}`} ·{" "}
                {attempt.latency_ms === null ? "Time unavailable" : `${attempt.latency_ms}ms`}
              </div>
              {attempt.error ? <span className="text-destructive">{attempt.error}</span> : null}
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type PageSearchParams = Promise<{ disable_error?: string }>;

export default async function SubscriptionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ subscriptionId: string }>;
  searchParams: PageSearchParams;
}) {
  const { subscriptionId: raw } = await params;
  const subscriptionId = decodeURIComponent(raw);
  const { disable_error: disableError = "" } = await searchParams;

  let subscription: ClientEventSubscriptionDetail | null;
  try {
    subscription = await getClientEventSubscription(subscriptionId).catch((err) => {
      if (err instanceof ReferenceServerUnreachableError) {
        throw err;
      }
      return null;
    });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
        <PageHeader
            actions={
              <Link
                className="pdpp-caption text-muted-foreground underline-offset-2 hover:underline"
                href="/event-subscriptions"
              >
                ← Webhooks
              </Link>
            }
          title="Webhooks"
          description="Send a message to your own address when something changes."
          />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  if (!subscription) {
    notFound();
  }

  const hideDisableForm = HIDE_DISABLE_FORM_STATUSES.has(subscription.status);

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link
            className="pdpp-caption text-muted-foreground underline-offset-2 hover:underline"
            href="/event-subscriptions"
          >
            ← Webhooks
          </Link>
        }
        description="Send a message to your own address when something changes."
        title="Webhooks"
      />

      <Sheet>
        <SheetHead>
          <div className="flex flex-wrap items-baseline gap-2">
            <SheetTitle>{subscription.callback_host}</SheetTitle>
            <Endorse
              label={subscriptionEndorseLabel(subscription.status)}
              status={subscriptionEndorseStatus(subscription.status)}
            />
          </div>
          <details className="pdpp-caption mt-2 text-muted-foreground">
            <summary className="cursor-pointer text-foreground">Details</summary>
            <div className="mt-1 flex flex-wrap gap-2">
              Webhook <SheetSerial>{subscription.subscription_id}</SheetSerial>
              · App <SheetSerial>{subscription.client_id}</SheetSerial>
              · Access{" "}
              <Link className="underline-offset-2 hover:underline" href={dashboardRoutes.grant(subscription.grant_id)}>
                <SheetSerial>{subscription.grant_id}</SheetSerial>
              </Link>
            </div>
          </details>
        </SheetHead>
        <SheetBody>
          <KV className="mb-4">
            <KVRow k="Address">
              <span className="break-all">
                {subscription.callback_url}
              </span>
            </KVRow>
            <KVRow k="Created">
              {relativeTime(subscription.created_at)}
            </KVRow>
            <KVRow k="Updated">
              {relativeTime(subscription.updated_at)}
            </KVRow>
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
            <KVRow k="What it listens for">{describeScope(subscription.scope)}</KVRow>
          </KV>

          {hideDisableForm ? (
            <DisabledNoticeCopy status={subscription.status} subscriptionId={subscription.subscription_id} />
          ) : (
            <DisableForm disableError={disableError} subscriptionId={subscription.subscription_id} />
          )}

          <RecentAttempts attempts={subscription.recent_attempts} />
        </SheetBody>
      </Sheet>
    </RecordroomShellWithPalette>
  );
}
