// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use client";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { plain } from "./plain-text.ts";
import { expiryLine, expiryTime, proofLine, type RouteDisplayInput } from "./route-display.ts";

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

/** One fact line under the address: an icon, then the sentence. */
function FactLine({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <span aria-hidden="true" className="w-4 flex-none text-center text-muted-foreground">
        {icon}
      </span>
      <span>{children}</span>
    </li>
  );
}

// The library's route fact that names who can read the traffic ("payload-readers"
// in every tunnel provider's definition). Its value is the eye line, verbatim.
type OnRouteFact = { id: string; group: string; known: boolean; value: unknown };
function trafficReaders(facts: OnRouteFact[]): string | null {
  for (const fact of facts) {
    if (fact.id === "payload-readers" && fact.known && typeof fact.value === "string" && fact.value.trim() !== "") {
      return plain(fact.value);
    }
  }
  return null;
}

// A cost the route states in a word or two; the definitions' prose cost summaries stay in Details.
function shortCost(facts: OnRouteFact[]): string | null {
  for (const fact of facts) {
    if (
      fact.group === "cost" &&
      fact.known &&
      typeof fact.value === "string" &&
      fact.value.trim() !== "" &&
      !fact.value.includes(";") &&
      fact.value.length <= 24
    ) {
      const value = plain(fact.value);
      return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
    }
  }
  return null;
}

/** The way a live route runs through, from the route's own provider. */
export type OnWay = { title: string; provider: string };

/**
 * The card for a route that is on: a status band, the address with Copy, the
 * three facts the owner still needs (when it ends, the way and cost it runs
 * through, who can read the traffic), the next step, and Details as a footer
 * row. The end time is the one the server reports for this route; the proof
 * line says how long ago the address was last checked. Nothing here says an app
 * is connected.
 */
export function OnCard({
  route,
  now,
  synthetic,
  addressChanged,
  busy,
  onTurnOff,
  way,
  children,
}: {
  route: RouteDisplayInput & { origin: string | null; facts?: OnRouteFact[] };
  now: number;
  synthetic: boolean;
  /** True when the displayed address replaced one the owner saw on this page. */
  addressChanged: boolean;
  busy: boolean;
  onTurnOff: () => void;
  /** The way the route runs through: its name, provider and short cost, when the route's provider is known. */
  way?: OnWay | null;
  /** Details, under the card's footer divider. */
  children?: ReactNode;
}) {
  const facts = route.facts ?? [];
  const end = expiryTime(route);
  const ends = expiryLine(route);
  const cost = shortCost(facts);
  const readers = trafficReaders(facts);
  const through = way ? `Through ${way.title} (${way.provider})${cost ? ` · ${cost}` : ""}` : null;
  return (
    <section aria-label="On" className="overflow-hidden rounded-xl border">
      <p className="border-b bg-emerald-500/5 px-4 py-3 text-sm font-medium" role="status">
        <span aria-hidden="true" className="mr-2 inline-block size-2.5 rounded-full bg-emerald-500 align-middle ring-4 ring-emerald-500/15" />
        {"On "}
        <span className="font-normal text-muted-foreground">· {proofLine(route, now, { synthetic })}</span>
      </p>
      <div className="grid gap-3 p-4">
        {addressChanged ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm" role="status">
            Your address changed. Update it wherever you pasted the old one, like ChatGPT.
          </p>
        ) : null}
        {route.origin ? (
          <div className="grid gap-2">
            <span className="pdpp-label uppercase tracking-wide">Your address</span>
            <p className="rounded-lg border bg-muted/40 px-3 py-2.5 font-mono text-sm break-all">{route.origin}</p>
            <div className="flex flex-wrap items-center gap-3">
              <CopyButton label="Copy address" text={route.origin} variant="default" />
            </div>
          </div>
        ) : (
          <p className="pdpp-caption">Your address: Not available yet</p>
        )}
        <ul className="grid gap-2">
          {ends ? <FactLine icon="⏱">{end !== null ? `${ends}. Keep this computer awake and online until then.` : ends}</FactLine> : null}
          {through ? <FactLine icon="↔">{through}</FactLine> : null}
          {readers ? <FactLine icon="👁">{readers}</FactLine> : null}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5">
          <div className="grid gap-0.5">
            <span className="text-sm font-medium">Next: connect ChatGPT or Claude</span>
            <span className="pdpp-caption">Connect apps uses this address and asks you to approve each app.</span>
          </div>
          <a className="text-sm font-medium underline-offset-4 hover:underline" href={dashboardRoutes.section.connect}>
            Connect apps ›
          </a>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button disabled={busy} onClick={onTurnOff} type="button" variant="outline">
            Turn off
          </Button>
        </div>
        <div className="grid gap-3 border-t pt-3">{children}</div>
      </div>
    </section>
  );
}
