// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use client";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { Inventory } from "./prepare-remote-access.ts";
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
export type OnWay = { title: string; provider: string; reach: Inventory["providers"][number]["reach"] };

type AccessStatus = { status: string; sentence: string; tone: "available" | "attention" | "quiet" };

function accessStatuses(
  route: RouteDisplayInput,
  reach: OnWay["reach"] | undefined
): { chatgpt: AccessStatus; phone: AccessStatus } {
  if (reach === "internet") {
    if (route.verification.status === "verified" && route.verification.vantage === "public") {
      return {
        chatgpt: { status: "Available", sentence: "This address works from the internet; connect ChatGPT below.", tone: "available" },
        phone: { status: "Available", sentence: "Open this address on your phone.", tone: "available" },
      };
    }
    const notChecked = "We haven't confirmed this address from the internet yet.";
    return {
      chatgpt: { status: "Not confirmed", sentence: notChecked, tone: "quiet" },
      phone: { status: "Not confirmed", sentence: notChecked, tone: "quiet" },
    };
  }

  if (reach === "tailnet") {
    return {
      chatgpt: { status: "Not available", sentence: "ChatGPT needs an address that works from the internet.", tone: "quiet" },
      phone: { status: "Needs Tailscale", sentence: "Use Tailscale on your phone with the same account.", tone: "attention" },
    };
  }

  if (reach === "lan") {
    return {
      chatgpt: { status: "Not available", sentence: "ChatGPT needs an address that works from the internet.", tone: "quiet" },
      phone: { status: "Same Wi-Fi", sentence: "Your phone and this computer need the same Wi-Fi.", tone: "attention" },
    };
  }

  return {
    chatgpt: { status: "Unknown", sentence: "We don't know whether ChatGPT can open this address.", tone: "quiet" },
    phone: { status: "Unknown", sentence: "We don't know whether your phone can open this address.", tone: "quiet" },
  };
}

function ReachStatus({ label, access }: { label: string; access: AccessStatus }) {
  const tone = {
    available: "text-primary",
    attention: "text-attention",
    quiet: "text-muted-foreground",
  }[access.tone];

  return (
    <div className="grid gap-0.5 border-b border-border/70 py-2 last:border-b-0">
      <p className="text-[13px]">
        <span className={tone}>{access.status}</span>
        <span className="text-muted-foreground"> · {label}</span>
      </p>
      <p className="text-[13px] text-muted-foreground">{access.sentence}</p>
    </div>
  );
}

/**
 * The card for a route that is on: status, the address with Copy, the phone and
 * ChatGPT outcomes, the three facts the owner still needs (when it ends, the
 * way and cost it runs through, who can read the traffic), the next step, and
 * Details as a footer row. The end time is the one the server reports for this
 * route; the proof line says how long ago the address was last checked. Nothing
 * here says an app is connected.
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
  /** The way the route runs through: its name, provider, reach and short cost, when known. */
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
  const access = accessStatuses(route, way?.reach);
  return (
    <section aria-label="On" className="grid">
      <p className="border-b border-border/70 py-3 text-sm" role="status">
        <span className="text-primary">On</span>
        <span className="text-muted-foreground"> · {proofLine(route, now, { synthetic })}</span>
      </p>
      <div className="grid gap-3 py-3">
        {addressChanged ? (
          <p className="text-sm text-attention" role="status">
            Your address changed. Update it wherever you pasted the old one, like ChatGPT.
          </p>
        ) : null}
        {route.origin ? (
          <div className="grid gap-2">
            <span className="text-[13px] text-muted-foreground">Your address</span>
            <p className="break-all text-sm">{route.origin}</p>
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
        <section aria-label="Who can open this address" className="grid border-y border-border/70">
          <ReachStatus access={access.chatgpt} label="ChatGPT" />
          <ReachStatus access={access.phone} label="Your phone" />
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border/70 py-3">
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
        {children ? <div className="grid gap-3 border-t border-border/70 pt-3">{children}</div> : null}
      </div>
    </section>
  );
}
