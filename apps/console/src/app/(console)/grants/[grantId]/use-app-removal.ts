"use client";
import { useRouter } from "next/navigation";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import type { AppAccessSourceIdentity } from "../../lib/ref-client.ts";
import { removeAppAction } from "../remove-app-action.ts";
export function useAppRemoval(
  clientIds: string[],
  practice: boolean,
  initialQuestion: string | null = null,
  failed = false
) {
  const router = useRouter();
  const [question, setQuestion] = useState<string | null>(initialQuestion);
  const [error, setError] = useState<{ source: string; message: string } | null>(
    failed ? { source: "all", message: "The practice server could not be reached." } : null
  );
  const [removed, setRemoved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function remove(key: string, source?: AppAccessSourceIdentity) {
    setBusy(true);
    setError(null);
    const result = practice
      ? { ok: true, message: null }
      : await removeAppAction({ client_ids: clientIds, ...(source ? { source } : {}) }).catch(() => ({
          ok: false,
          message: "Access could not be removed. Try again.",
        }));
    setBusy(false);
    if (!result.ok) {
      setError({ source: key, message: result.message || "Access could not be removed. Try again." });
      if (!practice) {
        router.refresh();
      }
      return;
    }
    setQuestion(null);
    setRemoved((previous) => [...previous, key]);
    if (!practice) {
      router.refresh();
    }
  }
  return { question, setQuestion, error, removed, busy, remove };
}
