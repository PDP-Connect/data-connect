// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { WebPushSettings } from "@/app/(console)/components/web-push-settings.tsx";
import { SupportCopy } from "../components/support-copy.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { getWebPushConfig, listWebPushSubscriptions } from "../lib/ref-client.ts";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { settingsTrail } from "../settings/settings-trail.ts"

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Notifications",
};

async function loadNotificationState() {
  const [config, subscriptions] = await Promise.all([getWebPushConfig(), listWebPushSubscriptions()]);
  return { config, subscriptions: subscriptions.data };
}

export default async function NotificationsPage({ searchParams }: { searchParams?: Promise<{ demo?: string }> }) {
  const params = await searchParams;
  const practice = process.env.NODE_ENV !== "production" && ["off", "on", "blocked", "unsupported", "insecure", "devices"].includes(params?.demo ?? "") ? params!.demo : undefined;
  if (practice) return <RecordroomShellWithPalette><main className="mx-auto grid w-full max-w-5xl gap-4"><PageHeading /><WebPushSettings plain practice={practice} config={{ object: "web_push_config", enabled: true, public_key: "practice", unavailable_reason: null }} subscriptions={[]} /></main></RecordroomShellWithPalette>;
  let state: Awaited<ReturnType<typeof loadNotificationState>> | null = null;
  let unreachable = false;
  let loadError = "Notifications could not be loaded";

  try {
    state = await loadNotificationState();
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      unreachable = true;
      loadError = err.message;
    } else {
      throw err;
    }
  }

  if (unreachable || !state) {
    return (
      <RecordroomShellWithPalette>
        <main className="mx-auto w-full max-w-5xl">
          <PageHeading />
          <p className="text-[15px] text-muted-foreground">
            This could not be loaded. <Link className="text-primary underline" href="/notifications">Try again</Link>.
          </p>
          <SupportCopy details={loadError} />
        </main>
      </RecordroomShellWithPalette>
    );
  }

  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <PageHeading />
        <WebPushSettings plain config={state.config} subscriptions={state.subscriptions} />
      </main>
    </RecordroomShellWithPalette>
  );
}

function PageHeading() {
  return (
    <PageHeader
      breadcrumbs={settingsTrail("Notifications")}
      description="A message on this device when a sync needs you."
      title="Notifications"
    />
  );
}
