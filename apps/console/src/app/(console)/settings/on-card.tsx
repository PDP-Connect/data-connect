"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { type ReactNode, useState } from "react";
import { expiryLine, proofLine, type RouteDisplayInput } from "./route-display.ts";

/** Copies text and says so. The clipboard may be missing; then nothing changes. */
export function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
      type="button"
    >
      {copied ? "Copied" : label}
    </button>
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
  /** True after Turn on again produced a different address. */
  addressChanged: boolean;
  busy: boolean;
  onTurnOff: () => void;
  /** Details. */
  children?: ReactNode;
}) {
  const ends = expiryLine(route);
  return (
    <section aria-label="On" className="grid gap-3">
      <h3 className="pdpp-label">On</h3>
      {addressChanged ? (
        <p role="status">Your address changed. Update it wherever you pasted the old one, like ChatGPT.</p>
      ) : null}
      {route.origin ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="pdpp-caption break-words">Your address: {route.origin}</p>
          <CopyButton label="Copy address" text={route.origin} />
        </div>
      ) : (
        <p className="pdpp-caption">Your address: Not available yet</p>
      )}
      <p className="pdpp-caption">{proofLine(route, now, { synthetic })}</p>
      {ends ? <p className="pdpp-caption">{ends}</p> : null}
      <p>
        <a href="/connect">Next: connect ChatGPT or Claude</a>
      </p>
      <div className="flex flex-wrap gap-3">
        <button disabled={busy} onClick={onTurnOff} type="button">
          Turn off
        </button>
      </div>
      {children}
    </section>
  );
}
