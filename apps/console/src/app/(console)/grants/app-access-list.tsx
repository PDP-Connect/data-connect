"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Menu } from "@base-ui/react/menu";
import { IcButton } from "@pdpp/brand-react";
import Link from "next/link";
import { useState } from "react";
import { formatAppLastRead, type AppAccess } from "./app-access.ts";

export function AppAccessList({
  apps,
  canRemove,
  removeAction,
  returnTo,
}: {
  apps: readonly AppAccess[];
  canRemove: boolean;
  removeAction: (formData: FormData) => void | Promise<void>;
  returnTo: string;
}) {
  if (apps.length === 0) {
    return <p className="py-4 text-[13px] text-muted-foreground">No app can read your data yet.</p>;
  }

  return (
    <ul className="divide-y divide-border border-y border-border">
      {apps.map((app) => (
        <AppAccessRow app={app} canRemove={canRemove} key={`${app.name}:${app.hrefId}`} removeAction={removeAction} returnTo={returnTo} />
      ))}
    </ul>
  );
}

function AppAccessRow({
  app,
  canRemove,
  removeAction,
  returnTo,
}: {
  app: AppAccess;
  canRemove: boolean;
  removeAction: (formData: FormData) => void | Promise<void>;
  returnTo: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-3">
      <Link className="min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/grants/${encodeURIComponent(app.hrefId)}`}>
        <span className="block truncate text-[15px] font-medium text-foreground">{app.name}</span>
        <span className="mt-1 block text-[13px] text-muted-foreground">
          Can read {app.sources.length ? app.sources.join(", ") : "data from this server"}
        </span>
        <span className="mt-0.5 block text-[13px] tabular-nums text-muted-foreground">
          Last read {formatAppLastRead(app.lastRead)}
          {app.status ? ` · ${app.status}` : ""}
        </span>
      </Link>
      {canRemove && app.status === null ? (
        <Menu.Root>
          <Menu.Trigger
            aria-label={`More actions for ${app.name}`}
            className="inline-flex size-11 items-center justify-center rounded-[6px] text-[20px] text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          >
            …
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner className="z-50" sideOffset={6}>
              <Menu.Popup className="min-w-40 rounded-[6px] border border-border bg-background p-1 shadow-lg">
                <Menu.Item
                  className="flex min-h-11 cursor-pointer items-center rounded px-3 text-[13px] text-destructive outline-none data-[highlighted]:bg-muted"
                  onClick={() => setConfirming(true)}
                >
                  Remove access
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ) : null}
      {confirming ? (
        <div aria-labelledby={`remove-title-${app.hrefId}`} aria-modal="true" className="col-span-full rounded-[6px] border border-border-strong p-3" role="alertdialog">
          <p className="text-[13px] text-foreground" id={`remove-title-${app.hrefId}`}>
            {app.name} will no longer read your data. It keeps what it already read.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={removeAction}>
              {app.grantIds.map((grantId) => <input key={grantId} name="grant_id" type="hidden" value={grantId} />)}
              <input name="confirm_revoke" type="hidden" value="yes" />
              <input name="return_to" type="hidden" value={returnTo} />
              <IcButton size="sm" type="submit" variant="destructive">Remove access</IcButton>
            </form>
            <IcButton onClick={() => setConfirming(false)} size="sm" type="button" variant="ghost">Cancel</IcButton>
          </div>
        </div>
      ) : null}
    </li>
  );
}
