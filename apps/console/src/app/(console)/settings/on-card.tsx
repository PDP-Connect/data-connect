"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { expiryLine, proofLine, type RouteDisplayInput } from "./route-display.ts";

/** Copies text and says so. The clipboard may be missing; then nothing changes. */
export function CopyButton({
  label,
  text,
  variant = "secondary",
}: {
  label: string;
  text: string;
  /** Filled for the card's one primary action, quiet for everything else. */
  variant?: "default" | "secondary" | "outline";
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
      type="button"
      variant={variant}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * The card for a route that is on. The end time is the one the server reports
 * for this route; the proof line says how long ago the address was last checked.
 * Nothing here says an app is connected.
 */
export function OnCard({
  route,
  now,
  synthetic,
  addressChanged,
  busy,
  onTurnOff,
  children,
}: {
  route: RouteDisplayInput & { origin: string | null };
  now: number;
  synthetic: boolean;
  /** True when the displayed address replaced one the owner saw on this page. */
  addressChanged: boolean;
  busy: boolean;
  onTurnOff: () => void;
  /** Details. */
  children?: ReactNode;
}) {
  const ends = expiryLine(route);
  return (
    <section aria-label="On" className="grid gap-3">
      <p className="flex items-center gap-2 text-sm font-medium" role="status">
        <span aria-hidden="true" className="size-2.5 flex-none rounded-full bg-emerald-500 ring-4 ring-emerald-500/15" />
        On <span className="font-normal text-muted-foreground">· {proofLine(route, now, { synthetic })}</span>
      </p>
      {addressChanged ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm" role="status">
          Your address changed. Update it wherever you pasted the old one, like ChatGPT.
        </p>
      ) : null}
      {route.origin ? (
        <div className="grid gap-2">
          <span className="pdpp-label">Your address</span>
          <p className="rounded-lg border bg-muted/40 px-3 py-2.5 font-mono text-sm break-all">{route.origin}</p>
          <div className="flex flex-wrap items-center gap-3">
            <CopyButton label="Copy address" text={route.origin} variant="default" />
          </div>
        </div>
      ) : (
        <p className="pdpp-caption">Your address: Not available yet</p>
      )}
      {ends ? <p className="pdpp-caption">{ends}</p> : null}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border p-3.5">
        <div className="grid gap-0.5">
          <a className="text-sm font-medium underline-offset-4 hover:underline" href="/connect">
            Next: connect ChatGPT or Claude
          </a>
          <span className="pdpp-caption">Connect apps uses this address and asks you to approve each app.</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} onClick={onTurnOff} type="button" variant="outline">
          Turn off
        </Button>
      </div>
      {children}
    </section>
  );
}
