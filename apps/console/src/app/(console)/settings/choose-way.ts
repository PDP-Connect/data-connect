// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Which way Remote access recommends, and the "Other ways" list. A projection
// of the host's catalog: it reads each way's availability and prerequisites and
// nothing about the operating system.
import { type Inventory, pickUsage } from "./prepare-remote-access.ts";
import { plain } from "./plain-text.ts";

type Provider = Inventory["providers"][number];
type Capabilities = Parameters<typeof pickUsage>[1];

export type GroupId = "lasting" | "own-devices" | "advanced";
export type Missing = { text: string; link?: { label: string; href: string } };
export type WayRow = {
  providerId: string;
  reach: string;
  title: string;
  line: string;
  group: GroupId;
  /** True when this computer can run the way now (the radio is enabled). */
  usable: boolean;
  /** What stops the way, in plain words. Null when nothing does. */
  missing: Missing | null;
};

const tailscaleDownload = "https://tailscale.com/download";
const funnelHelp = "https://tailscale.com/kb/1223/funnel";

const copy: Record<string, { title: string; line: string; group: GroupId }> = {
  "localhost-run": {
    title: "Temporary address",
    line: "Free, no account, ready in seconds. Good for a quick test. For everyday use with ChatGPT, pick a lasting address under Other ways.",
    group: "advanced",
  },
  "tailscale-funnel": {
    title: "Tailscale · public address",
    line: "Lasting address. Tailscale's relay can't read what passes through. Needs a free account.",
    group: "lasting",
  },
  "cloudflare-named": {
    title: "Cloudflare",
    line: "Lasting address on a web domain you own (bought separately). Cloudflare can see what passes through.",
    group: "lasting",
  },
  "ngrok-https-edge": { title: "ngrok", line: "Lasting address. ngrok can see what passes through.", group: "lasting" },
  "tailscale-private": {
    title: "Tailscale · my devices only",
    line: "Your phone and laptops signed in to Tailscale. AI apps can't use it.",
    group: "own-devices",
  },
  lan: { title: "Same Wi-Fi only", line: "Devices on your home network. AI apps can't use it.", group: "own-devices" },
  "own-address": { title: "Your own address", line: "You already run a web server or proxy.", group: "advanced" },
  "ngrok-tls-passthrough": {
    title: "ngrok (advanced, TLS)",
    line: "Your computer handles encryption.",
    group: "advanced",
  },
  "ngrok-tcp-passthrough": {
    title: "ngrok (advanced, TCP)",
    line: "Your computer handles encryption.",
    group: "advanced",
  },
  "tunnl-gg": { title: "tunnl.gg", line: "Free, no account. Turns off after 2 hours idle.", group: "advanced" },
};

export const groupTitles: Record<GroupId, { title: string; note: string }> = {
  lasting: { title: "Lasting address for AI apps", note: "Needs a free account with the service." },
  "own-devices": { title: "Only my own devices", note: "AI apps like ChatGPT can't use these." },
  advanced: { title: "Advanced", note: "" },
};
export const groupOrder: GroupId[] = ["lasting", "own-devices", "advanced"];

/** Rows meant for development: every usage is detect-only. They never reach the owner. */
const isDevelopmentOnly = (provider: Provider) => {
  const states = Object.values(provider.availability).map((item) => item.state);
  return states.length > 0 && states.every((state) => state === "detect-only");
};

const prerequisiteState = (provider: Provider, id: string) => provider.prerequisites.find((item) => item.id === id)?.state;

const isTailscale = (provider: Provider) => provider.providerId.startsWith("tailscale-");

/**
 * What the host reports for Tailscale: `local-setup` is present when the
 * Tailscale app is installed and signed in. A prerequisite the host reports as
 * missing or denied (for example Funnel not allowed) blocks the way.
 */
function blockedStep(provider: Provider): Missing | null {
  if (!isTailscale(provider)) {
    const missing = provider.prerequisites.find((item) => item.state === "denied" || item.state === "missing");
    return missing ? { text: `Needs ${plain(missing.label)} (${missing.state}).` } : null;
  }
  const local = prerequisiteState(provider, "local-setup");
  if (local !== "present" && local !== "unknown") {
    return { text: "Needs the Tailscale app, signed in.", link: { label: "Get Tailscale", href: tailscaleDownload } };
  }
  if (provider.prerequisites.some((item) => item.state === "denied" || item.state === "missing")) {
    return provider.providerId === "tailscale-funnel"
      ? { text: "Funnel isn't allowed on your Tailscale account yet.", link: { label: "How to allow it", href: funnelHelp } }
      : { text: "Tailscale needs a step before this works." };
  }
  return null;
}

// Reasons the host gives for a way it cannot run, in the owner's words.
const unsupportedText = "Can't run on this computer.";

/**
 * Ways whose own setup ended blocked on a step only an administrator can do,
 * by provider id. The console learns this from the setup, not the catalog.
 */
export type Blocks = Readonly<Record<string, Missing>>;

/** The one setup outcome that demotes a way: Tailscale Funnel not allowed on this node. */
export const funnelPolicyActionId = "tailscale-funnel-policy";

/** What the owner reads for a Funnel setup blocked on the administrator step. */
export function funnelPolicyBlock(href: string | undefined): Missing {
  const url = href ? URL.parse(href) : null;
  const safe = url?.protocol === "https:" && !url.username && !url.password ? url.href : funnelHelp;
  return {
    text: "Funnel isn't allowed on this Tailscale device yet. Ask an administrator to allow it.",
    link: { label: "Open Tailscale access controls", href: safe },
  };
}

function missingFor(provider: Provider, capabilities: Capabilities, blocks: Blocks = {}): Missing | null {
  const blocked = blocks[provider.providerId];
  if (blocked) return blocked;
  const step = blockedStep(provider);
  if (step) return step;
  return pickUsage(provider, capabilities) === null ? { text: unsupportedText } : null;
}

/**
 * True when the way can no longer be used: the host says it is not available,
 * a prerequisite is missing or denied, or its setup ended blocked. A
 * prerequisite the host cannot read right now (`unknown`, for example while an
 * app restarts) does not count, so a pinned way survives a short gap.
 */
export function wayUnusable(provider: Provider, capabilities: Capabilities, blocks: Blocks = {}): boolean {
  return missingFor(provider, capabilities, blocks) !== null;
}

/**
 * The way to recommend: the best one this computer can finish now. Tailscale
 * public address when Tailscale is ready and nothing is missing; otherwise the
 * temporary address. Falls back to the first way this computer can run.
 */
export function recommendedWay(inventory: Inventory, capabilities: Capabilities, blocks: Blocks = {}): Provider | undefined {
  const visible = inventory.providers.filter((item) => !isDevelopmentOnly(item));
  const runnable = (item: Provider) => missingFor(item, capabilities, blocks) === null;
  const funnel = visible.find((item) => item.providerId === "tailscale-funnel");
  if (funnel && runnable(funnel)) return funnel;
  const temporary = visible.find((item) => item.providerId === "localhost-run");
  if (temporary && runnable(temporary)) return temporary;
  return (
    visible.find((item) => runnable(item) && item.reach !== "lan" && pickUsage(item, capabilities) === "session") ??
    visible.find((item) => runnable(item) && item.reach !== "lan") ??
    visible.find(runnable)
  );
}

export function wayRow(provider: Provider, capabilities: Capabilities, blocks: Blocks = {}): WayRow {
  const known = copy[provider.providerId];
  const missing = missingFor(provider, capabilities, blocks);
  return {
    providerId: provider.providerId,
    reach: provider.reach,
    title: known?.title ?? plain(provider.label),
    line: known?.line ?? "",
    group: known?.group ?? "advanced",
    usable: missing === null,
    missing,
  };
}

/** The visible ways under "Other ways": three groups, ways that can run first, the recommended way left out. */
export function otherWays(inventory: Inventory, capabilities: Capabilities, recommendedId: string | null, blocks: Blocks = {}) {
  const rows = inventory.providers
    .filter((item) => !isDevelopmentOnly(item) && item.providerId !== recommendedId)
    .map((item) => wayRow(item, capabilities, blocks));
  return groupOrder.map((id) => ({
    id,
    ...groupTitles[id],
    rows: rows.filter((row) => row.group === id).sort((a, b) => Number(b.usable) - Number(a.usable)),
  }));
}
