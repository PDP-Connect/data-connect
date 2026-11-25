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
    line: "Free. Needs no account.",
    group: "advanced",
  },
  "tailscale-funnel": {
    title: "Tailscale · public address",
    line: "Free. Needs a Tailscale account.",
    group: "lasting",
  },
  "cloudflare-named": {
    title: "Cloudflare",
    line: "Needs a domain you own.",
    group: "lasting",
  },
  "ngrok-https-edge": { title: "ngrok", line: "Free. Needs an account with the service.", group: "lasting" },
  "tailscale-private": {
    title: "Tailscale · my devices only",
    line: "Free. Needs the Tailscale app on your phone and computer.",
    group: "own-devices",
  },
  lan: { title: "Same Wi-Fi only", line: "Free. Your phone and computer need the same Wi-Fi.", group: "own-devices" },
  "own-address": { title: "Your own address", line: "Needs a web address you already use.", group: "advanced" },
  "ngrok-tls-passthrough": {
    title: "ngrok encrypted web address",
    line: "The connection stays encrypted until it reaches this computer.",
    group: "advanced",
  },
  "ngrok-tcp-passthrough": {
    title: "ngrok network address",
    line: "Uses an address without a domain name. The connection stays encrypted until it reaches this computer.",
    group: "advanced",
  },
  "tunnl-gg": { title: "Temporary hosted address", line: "Free. Needs no account.", group: "advanced" },
};

export const groupTitles: Record<GroupId, { title: string; note: string }> = {
  lasting: { title: "Addresses ChatGPT can open", note: "These work from the internet." },
  "own-devices": { title: "Your phone and computers", note: "These work only on your devices." },
  advanced: { title: "Details", note: "" },
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
 * A missing prerequisite the owner fixes by typing a token or a value during
 * setup does not block the way: choosing it starts that setup. Other remedies
 * (a link, an administrator step, a kind this console does not know) still block.
 */
function typedDuringSetup(remedy: { kind?: unknown } | null | undefined): boolean {
  return remedy?.kind === "provide-secret" || remedy?.kind === "provide-value";
}

/**
 * What the host reports for Tailscale: `local-setup` is present when the
 * Tailscale app is installed and signed in. A prerequisite the host reports as
 * missing or denied (for example Funnel not allowed) blocks the way.
 */
function blockedStep(provider: Provider): Missing | null {
  if (!isTailscale(provider)) {
    const missing = provider.prerequisites.find(
      (item) => item.state === "denied" || (item.state === "missing" && !typedDuringSetup(item.remedy))
    );
    return missing ? { text: "This way needs another step before it can work." } : null;
  }
  const local = prerequisiteState(provider, "local-setup");
  if (local !== "present" && local !== "unknown") {
    return { text: "Needs the Tailscale app, signed in.", link: { label: "Get Tailscale", href: tailscaleDownload } };
  }
  if (provider.prerequisites.some((item) => item.state === "denied" || item.state === "missing")) {
    return provider.providerId === "tailscale-funnel"
      ? { text: "Your account needs another step before this address can work.", link: { label: "View the account steps", href: funnelHelp } }
      : { text: "Your Tailscale account needs another step before this works." };
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
    text: "An administrator needs to allow this address on the computer.",
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
 * a prerequisite is denied or missing with no remedy, or its setup ended blocked. A
 * prerequisite the host cannot read right now (`unknown`, for example while an
 * app restarts) does not count, so a pinned way survives a short gap.
 */
export function wayUnusable(provider: Provider, capabilities: Capabilities, blocks: Blocks = {}): boolean {
  return missingFor(provider, capabilities, blocks) !== null;
}

/**
 * Whether the host has positively seen this way's prerequisites met. Tailscale's
 * catalog entry reads `present` once the command-line tool is found, with the
 * version "not-observed" (gozar embedding-state.mjs prerequisitesFor). That is the
 * same whether the daemon is stopped, signed out or signed in, so it proves
 * nothing about sign-in. Only a way the owner already set up (`setUp`) or a
 * prerequisite the host observed with a version counts. Any other way counts
 * once no prerequisite is missing, so one that still needs setup input is not.
 */
function confirmedReady(provider: Provider, setUp: ReadonlySet<string>): boolean {
  if (!isTailscale(provider)) return !provider.prerequisites.some((item) => item.state === "missing");
  if (setUp.has(provider.providerId)) return true;
  const local = provider.prerequisites.find((item) => item.id === "local-setup");
  return local?.state === "present" && local.version.known === true;
}

/**
 * The way to recommend: the best one this computer can finish now with its
 * prerequisites known to be met. A way that needs a sign-in is not recommended
 * over one that needs none. Tailscale public address when it is set up; otherwise
 * the temporary address. Falls back to the first way this computer can run.
 */
export function recommendedWay(
  inventory: Inventory,
  capabilities: Capabilities,
  blocks: Blocks = {},
  setUp: ReadonlySet<string> = new Set()
): Provider | undefined {
  const visible = inventory.providers.filter((item) => !isDevelopmentOnly(item));
  const runnable = (item: Provider) => missingFor(item, capabilities, blocks) === null;
  const ready = (item: Provider) => runnable(item) && confirmedReady(item, setUp);
  const funnel = visible.find((item) => item.providerId === "tailscale-funnel");
  if (funnel && ready(funnel)) return funnel;
  const temporary = visible.find((item) => item.providerId === "localhost-run");
  if (temporary && ready(temporary)) return temporary;
  return (
    visible.find((item) => ready(item) && item.reach !== "lan" && pickUsage(item, capabilities) === "session") ??
    visible.find((item) => ready(item) && item.reach !== "lan") ??
    visible.find(ready) ??
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
