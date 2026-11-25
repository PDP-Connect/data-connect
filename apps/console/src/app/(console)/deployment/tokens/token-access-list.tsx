"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Menu } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { useState } from "react";
import type { OwnerIssuedClient } from "../../lib/ref-client.ts";
import { revokeOwnerClientTokenAction, revokeOwnerTokenAction } from "./actions.ts";

export interface AccessTokenRow extends OwnerIssuedClient {
  createdLabel: string;
  details?: ReactNode;
  lastUsedLabel: string;
}

export function TokenAccessList({ tokens }: { tokens: AccessTokenRow[] }) {
  if (tokens.length === 0) {
    return <p className="border-y border-border/70 py-4 text-[15px] text-muted-foreground">No access tokens yet.</p>;
  }

  return (
    <>
      <div className="hidden grid-cols-[minmax(8rem,1.3fr)_minmax(6rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_2.75rem] border-y border-border/70 py-2 text-[13px] text-muted-foreground sm:grid">
        <span>Name</span><span>What it can read</span><span>Created</span><span>Last used</span><span />
      </div>
      <ul className="divide-y divide-border/70 border-b border-border/70">
        {tokens.map((token) => (
          <TokenAccessRow key={token.client_id} token={token} />
        ))}
      </ul>
    </>
  );
}

export function ConfirmTokenRevoke({ clientId, tokenIdPublic }: { clientId: string; tokenIdPublic: string }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button className="min-h-11 rounded-[6px] px-3 text-[13px] text-destructive hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setConfirming(true)} type="button">
        Revoke this access token
      </button>
    );
  }
  return (
    <fieldset className="grid gap-2 border-0 p-0 sm:max-w-lg">
      <legend className="text-[13px] text-muted-foreground">Confirm access token revocation</legend>
      <p className="text-[13px] text-foreground">Revoke this access token? It will stop working, while the other tokens keep working.</p>
      <div className="flex flex-wrap gap-2">
        <form action={revokeOwnerClientTokenAction}>
          <input name="client_id" type="hidden" value={clientId} />
          <input name="token_id_public" type="hidden" value={tokenIdPublic} />
          <button className="min-h-11 rounded-[6px] px-3 text-[13px] text-destructive hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" type="submit">
            Confirm revoke
          </button>
        </form>
        <button className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setConfirming(false)} type="button">
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

function TokenAccessRow({ token }: { token: AccessTokenRow }) {
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_2.75rem] gap-x-2 py-3 sm:grid-cols-[minmax(8rem,1.3fr)_minmax(6rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_2.75rem] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-[15px] font-medium text-foreground">{token.client_name ?? "Unnamed access token"}</p>
        <p className="text-[13px] text-muted-foreground sm:hidden">Can read everything</p>
      </div>
      <p className="hidden text-[13px] text-muted-foreground sm:block">Everything</p>
      <p className="text-[13px] tabular-nums text-muted-foreground">
        <span className="sm:hidden">Created </span>{token.createdLabel}
      </p>
      <p className="text-[13px] text-muted-foreground">
        <span className="sm:hidden">Last used </span>{token.lastUsedLabel}
      </p>
      <div className="col-start-2 row-start-1 sm:col-auto sm:row-auto">
        <Menu.Root>
          <Menu.Trigger
            aria-label={`More actions for ${token.client_name ?? "access token"}`}
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
                  onClick={() => setConfirmingRevoke(true)}
                >
                  Revoke
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {token.details ? <div className="col-span-full min-w-0">{token.details}</div> : null}
      {confirmingRevoke ? (
        <div aria-labelledby={`revoke-title-${token.client_id}`} aria-modal="true" className="col-span-full rounded-[6px] border border-border-strong p-3" role="alertdialog">
          <p className="text-[13px] text-foreground" id={`revoke-title-${token.client_id}`}>
            Revoke “{token.client_name ?? "Unnamed access token"}”? This access token and its active credentials will stop working.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={revokeOwnerTokenAction}>
              <input name="client_id" type="hidden" value={token.client_id} />
              <button className="min-h-11 rounded-[6px] px-3 text-[13px] text-destructive hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" type="submit">
                Revoke access token
              </button>
            </form>
            <button
              className="min-h-11 rounded-[6px] border border-border px-3 text-[13px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setConfirmingRevoke(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
