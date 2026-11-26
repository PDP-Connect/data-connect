// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import type { Viewport } from "next";
import { notFound, redirect } from "next/navigation";
import { ReferenceServerUnreachableError } from "../../../lib/owner-token.ts";
import {
  getRunStatus,
  getRunTimeline,
  listConnectorSummaries,
  type RunStatusEnvelope,
  type SpineEvent,
  type TimelineEnvelope,
} from "../../../lib/ref-client.ts";
import { listConnectorManifests } from "../../../lib/rs-client.ts";
import {
  getCurrentBrowserSurfaceAssistance,
  getCurrentRunAssistance,
  hasActiveBrowserSurface,
  hasResolvedBrowserSurfaceAssistance,
  requiresBrowserSurfaceAssistance,
} from "../../../lib/run-assistance.ts";
import {
  buildConnectorContext,
  type ConnectorContext,
  resolveConnectorSummaryRouteId,
} from "./connector-context-resolution.ts";
import { normalizeInteractionPrompt } from "./interaction-prompt.ts";
import {
  selectNoAssistanceStreamState,
} from "./stream-state.ts";
import { ResolvedSurface, StreamSurface } from "./stream-viewer.tsx";

import { flowPreviewState } from "../../../connect/flow-preview.ts";

import { ExternalApprovalSurface, PreparingBrowserSurface, SignInFrame } from "./sign-in-parts.tsx";
import { setupStatusHref, signInDestination } from "./sign-in-flow.ts";

import { SignInPreview } from "./sign-in-preview.tsx";

export const dynamic = "force-dynamic";
export const viewport: Viewport = {
  initialScale: 1,
  interactiveWidget: "overlays-content",
  viewportFit: "cover",
  width: "device-width",
};

function getConnectorIdFromTimeline(events: SpineEvent[]): string | null {
  const fromRuntime = events.find((e) => e.actor_type === "runtime")?.actor_id ?? null;
  if (fromRuntime) {
    return fromRuntime;
  }
  for (const ev of events) {
    const candidate = (ev.data as { connector_id?: unknown } | null)?.connector_id;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

function getConnectorInstanceIdFromTimeline(events: SpineEvent[]): string | null {
  for (const ev of events) {
    const data = ev.data as {
      connection_id?: unknown;
      connector_instance_id?: unknown;
      source?: { connection_id?: unknown } | null;
    } | null;
    const candidates = [data?.connector_instance_id, data?.connection_id, data?.source?.connection_id];
    const match = candidates.find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0
    );
    if (match) {
      return match;
    }
  }
  return null;
}

async function resolveConnectorContext(
  connectorId: string | null,
  connectorInstanceId: string | null
): Promise<ConnectorContext | null> {
  if (!connectorId) {
    return null;
  }
  try {
    // The connection is already known (from the run timeline), so scope the
    // read to that one connection instead of fetching the whole fleet and
    // filtering client-side. The reference resolves exact connection identity
    // first and falls back to an unambiguous connector-id match, the same
    // resolution `connection-route.ts` relies on for the records subpage.
    const {
      data: [match],
    } = await listConnectorSummaries({
      connectionRouteId: resolveConnectorSummaryRouteId(connectorId, connectorInstanceId),
    });
    return buildConnectorContext(connectorId, match);
  } catch {
    return buildConnectorContext(connectorId, undefined);
  }
}

function renderNoAssistanceSurface({
  connector,
  currentAssistance,
  envelope,
  connectorInstanceId,
  runId,
  runStatus,
}: {
  connector: ConnectorContext | null;
  currentAssistance: ReturnType<typeof getCurrentRunAssistance>;
  connectorInstanceId: string | null;
  envelope: TimelineEnvelope;
  runId: string;
  runStatus: RunStatusEnvelope | null;
}) {
  const statusHref = setupStatusHref(connectorInstanceId, runId);
  const state = selectNoAssistanceStreamState({ runHandleStatus: runStatus?.status ?? null, terminalStatus: envelope.terminal_status });
  if (state === "ended") redirect(statusHref);
  if (currentAssistance?.ownerAction === "act_elsewhere" && currentAssistance.responseContract === "none") return <ExternalApprovalSurface connector={connector} message={currentAssistance.message} runId={runId} />;
  if (currentAssistance?.kind === "credentials") return <StreamSurface connector={connector} interactionId={currentAssistance.id} interactionKind="credentials" interactionMessage={currentAssistance.message} runId={runId} />;
  if (state === "resolved" || hasResolvedBrowserSurfaceAssistance(envelope.events)) return <ResolvedSurface connector={connector} runId={runId} statusHref={statusHref} />;
  if ((currentAssistance && requiresBrowserSurfaceAssistance(currentAssistance)) || hasActiveBrowserSurface(envelope.events)) return <PreparingBrowserSurface connector={connector} runId={runId} />;
  const destination = signInDestination(state, statusHref);
  if (destination) redirect(destination);
  return null;
}

export default async function RunInteractionStreamPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ _preview?: string; _state?: string; auto_open?: string }>;
}) {
  const { runId: raw } = await params;
  const runId = decodeURIComponent(raw);
  const sp = await searchParams;

  const preview = flowPreviewState("browser", sp);
  if (preview) return <SignInPreview state={preview} />;

  let envelope: TimelineEnvelope | null;
  let runStatus: RunStatusEnvelope | null;
  try {
    [envelope, runStatus] = await Promise.all([getRunTimeline(runId, { cursor: null }), getRunStatus(runId)]);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <SignInFrame connector={null} title="This page lost contact with DataConnect.">
          <section className="rounded-lg border border-destructive/30 p-6">
            <h1 className="pdpp-heading text-foreground">Can't reach DataConnect right now.</h1>
            <p className="mt-3 text-muted-foreground text-sm leading-6">
              Try again. If it still does not work, check server settings.
            </p>
            <div className="mt-5 flex flex-wrap gap-4 text-sm">
              <a
                className={buttonVariants({ size: "sm", variant: "default" })}
                href={`/syncs/${encodeURIComponent(runId)}/stream`}
              >
                Try again
              </a>
              <a className="text-primary underline-offset-2 hover:underline" href="/deployment">
                Server settings
              </a>
            </div>
          </section>
        </SignInFrame>
      );
    }
    throw err;
  }
  if (!envelope) {
    notFound();
    return null;
  }

  const streamableAssistance = getCurrentBrowserSurfaceAssistance(envelope.events);
  const currentAssistance = getCurrentRunAssistance(envelope.events);
  const connectorId = getConnectorIdFromTimeline(envelope.events);
  const connectorInstanceId = runStatus?.connector_instance_id ?? getConnectorInstanceIdFromTimeline(envelope.events);
  const connector = await resolveConnectorContext(connectorId, connectorInstanceId);
  const connectorWithIcon = connector
    ? {
        ...connector,
        icon:
          (await listConnectorManifests().catch(() => []))
            .find(
              (manifest) =>
                manifest.connector_id === connector.connectorId || manifest.connector_key === connector.connectorId
            )?.icon ?? null,
      }
    : null;

  if (!streamableAssistance) {
    return renderNoAssistanceSurface({
      connector: connectorWithIcon,
      connectorInstanceId,
      currentAssistance,
      envelope,
      runId,
      runStatus,
    });
  }

  return (
    <StreamSurface
      autoOpen={sp.auto_open === "1"}
      connector={connectorWithIcon}
      interactionId={streamableAssistance.id}
      // Only an OTP step gets the code field; every other browser step keeps the manual Done dock.
      interactionKind={streamableAssistance.kind === "otp" ? "otp" : "manual_action"}
      interactionMessage={normalizeInteractionPrompt(
        streamableAssistance.message,
        `This is ${connectorWithIcon?.displayName ?? "the data source"}'s own sign-in page, in a browser that DataConnect runs for you. When you are signed in, DataConnect carries on by itself.`
      )}
      interactionRequiresResponse={streamableAssistance.responseContract === "response_required"}
      runId={runId}
    />
  );
}
