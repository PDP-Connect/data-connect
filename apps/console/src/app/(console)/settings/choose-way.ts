// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Which way Remote access recommends, and the "Other ways" list. A projection
// of the host's catalog: it reads each way's availability and prerequisites and
// nothing about the operating system.
import { type Inventory, mayReachInternet, offersLastingAddress, pickUsage } from "./prepare-remote-access.ts";
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

/**
 * Where a way sits in the list, from what the catalog says about it and nothing
 * about which service it is: a way that reaches only your own network or devices
 * is "own-devices"; one that reaches the internet and offers an address that
 * outlives a run is "lasting"; the rest are "advanced".
 */
export function groupOf(provider: Provider): GroupId {
  if (!mayReachInternet(provider)) return "own-devices";
  return provider.reach === "internet" && offersLastingAddress(provider) ? "lasting" : "advanced";
}

/** The catalog's own cost sentence for the way, shown as its one line. Empty when the catalog states none. */
function lineOf(provider: Provider): string {
  const cost = provider.facts.find((fact) => fact.group === "cost" && fact.known && typeof fact.value === "string");
  return typeof cost?.value === "string" ? plain(cost.value) : "";
}

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
 * missing or denied blocks the way.
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
    return { text: "Tailscale needs a step before this works." };
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
 * Whether a lasting way is known to be set up. The catalog's prerequisite for a
 * way that needs an account reads `present` once its command-line tool is found,
 * with the version "not-observed" (gozar embedding-state.mjs prerequisitesFor),
 * whether or not anyone is signed in, so that alone proves nothing. Only a way
 * the owner already set up (`setUp`) or a prerequisite the host observed with a
 * version counts. A way that is not lasting needs no such proof.
 */
function confirmedReady(provider: Provider, setUp: ReadonlySet<string>): boolean {
  if (groupOf(provider) !== "lasting") return true;
  if (setUp.has(provider.providerId)) return true;
  const local = provider.prerequisites.find((item) => item.id === "local-setup");
  return local?.state === "present" && local.version.known === true;
}

/**
 * The way to recommend: the best one this computer can finish now with its
 * prerequisites known to be met. A way that needs a sign-in is not recommended
 * over one that needs none. A lasting address when it is set up; otherwise the
 * first temporary address on the internet. Falls back to the first way this
 * computer can run.
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
  // A lasting address the owner has already set up, then a temporary address on the internet that needs
  // no setup, then anything else this computer can finish.
  const lasting = visible.find((item) => groupOf(item) === "lasting" && ready(item));
  if (lasting) return lasting;
  const temporary = visible.find(
    (item) => item.reach === "internet" && !offersLastingAddress(item) && pickUsage(item, capabilities) === "session" && ready(item)
  );
  if (temporary) return temporary;
  return (
    visible.find((item) => ready(item) && mayReachInternet(item) && pickUsage(item, capabilities) === "session") ??
    visible.find((item) => ready(item) && mayReachInternet(item)) ??
    visible.find(ready) ??
    visible.find(runnable)
  );
}

export function wayRow(provider: Provider, capabilities: Capabilities, blocks: Blocks = {}): WayRow {
  const missing = missingFor(provider, capabilities, blocks);
  return {
    providerId: provider.providerId,
    reach: provider.reach,
    title: plain(provider.label),
    line: lineOf(provider),
    group: groupOf(provider),
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
