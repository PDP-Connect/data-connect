"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { IcButton } from "@pdpp/brand-react";
import { useState } from "react";
export function SupportCopy({ details }: { details: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try { await navigator.clipboard.writeText(JSON.stringify({ details, time: new Date().toISOString(), page: window.location.pathname })); setState("copied"); }
    catch { setState("failed"); }
  }
  return <div className="grid justify-items-start gap-1"><IcButton size="sm" variant="ghost" onClick={copy}>{state === "copied" ? "Copied" : "Copy details for support"}</IcButton>{state === "failed" ? <p role="status">Copying did not work. Allow clipboard access and try again.</p> : null}</div>;
}
