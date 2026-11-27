"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Text } from "@pdpp/brand-react";
import { formatRelative } from "@pdpp/display";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { revokeAllOwnerSessionsAction, revokeOtherOwnerSessionsAction, revokeOwnerSessionAction } from "./owner-sessions-actions.ts";
import type { OwnerSessionView } from "./owner-sessions-data.ts";
import { buildSignedInModel } from "./signed-in-model.ts";
export function SignedInSessions({ sessions, practice = false }: { sessions: OwnerSessionView[]; practice?: boolean }) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = buildSignedInModel(sessions, showAll);
  async function signOut() {
    if (!confirm || practice) return;
    setBusy(true); setError(null);
    try {
      const result = await (confirm === "others" ? revokeOtherOwnerSessionsAction() : confirm === "all" ? revokeAllOwnerSessionsAction() : revokeOwnerSessionAction(confirm));
      if (result.ok) { setConfirm(null); router.refresh(); }
      else setError(result.message ?? "Sign out failed");
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="grid gap-3">
    <Text as="p" color="muted">{model.total ? `Signed in on ${model.total} ${model.total === 1 ? "device" : "devices"}` : "No devices are signed in."}</Text>
    <div className="flex flex-wrap gap-2">
      {model.otherCount ? <Button disabled={busy} onClick={() => setConfirm("others")} type="button" variant="outline">Sign out everywhere else</Button> : null}
      {model.total ? <Button disabled={busy} onClick={() => setConfirm("all")} type="button" variant="ghost">Sign out all devices</Button> : null}
    </div>
    {confirm ? <div aria-label="Confirm sign out" className="grid gap-3 border-y border-border py-3" role="alertdialog">
      <Text as="p">{confirm === "others" ? "Sign out the other devices? They will need to sign in again." : confirm === "all" ? "Sign out all devices, including this one? You will need to sign in again." : "Sign out this device? It will need to sign in again."}</Text>
      <div className="flex gap-2"><Button disabled={busy || practice} onClick={() => void signOut()} type="button">Confirm sign out</Button><Button onClick={() => setConfirm(null)} type="button" variant="outline">Cancel</Button></div>
    </div> : null}
    {error ? <div role="alert"><Text as="p">Could not sign out. Try again.</Text><Button onClick={() => void navigator.clipboard?.writeText(error)} type="button" variant="outline">Copy details for support</Button></div> : null}
    {model.rows.map(row => <div className="flex items-start justify-between gap-3 border-b border-border/70 py-3" key={row.id}>
      <div className="grid gap-1"><Text as="p">{row.label}{row.current ? <span className="ml-2 text-sm text-muted-foreground">This browser</span> : null}</Text>
      <Text as="p" color="muted" size="small">Last seen {formatRelative(new Date(row.lastSeenAt * 1000), Date.now())} · signed in {new Date(row.createdAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{row.ipAddress ? ` · ${row.ipAddress}` : ""}</Text></div>
      {!row.current ? <Button disabled={busy} onClick={() => setConfirm(row.id)} type="button" variant="ghost">Sign out</Button> : null}
    </div>)}
    {!showAll && model.total > 5 ? <Button className="justify-self-start" onClick={() => setShowAll(true)} type="button" variant="ghost">Show all {model.total}</Button> : null}
  </div>;
}
