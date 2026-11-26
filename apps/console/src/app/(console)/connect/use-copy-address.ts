"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
export function useCopyAddress(address: string) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copy() {
    try { await navigator.clipboard.writeText(address); setCopied(true); setError(false); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 2000); }
    catch { setError(true); }
  }
  return { copied, error, copy };
}
