"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AppAccessSourceIdentity } from "../../lib/ref-client.ts";
import { removeAppAction } from "../remove-app-action.ts";
export function useAppRemoval(clientIds: string[], practice: boolean) {
  const router = useRouter();
  const [question, setQuestion] = useState<string | null>(null);
  const [error, setError] = useState<{ source: string; message: string } | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function remove(key: string, source?: AppAccessSourceIdentity) {
    setBusy(true); setError(null);
    const result = practice ? { ok: true, message: null } : await removeAppAction({ client_ids: clientIds, ...(source ? { source } : {}) });
    setBusy(false);
    if (!result.ok) { setError({ source: key, message: result.message || "Access could not be removed. Try again." }); return; }
    setQuestion(null); setRemoved((previous) => [...previous, key]);
    if (!practice) router.refresh();
  }
  return { question, setQuestion, error, removed, busy, remove };
}
