"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, Text } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import { checksHeadline, plainServerChecks, type PlainCheck } from "./plain-checks.ts";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  embeddingCacheRow,
  ownerPasswordRow,
  type ReadinessRow,
  referenceOriginRow,
  refreshTokenRow,
  type RefreshTokenProbe,
  type ServerInputs,
  storageBackendRow,
} from "../components/deployment-readiness-rows.ts";

export function ServerChecks({ inputs, technical = false, desktop = false, practice }: { inputs: ServerInputs; technical?: boolean; desktop?: boolean; practice?: { address: string | null; probe: RefreshTokenProbe } }) {
  if (technical) return <TechnicalServerChecks inputs={inputs} />;
  return <PlainServerChecks inputs={inputs} practice={practice} desktop={desktop} />;
}
function PlainServerChecks({ inputs, practice, desktop }: { inputs: ServerInputs; desktop: boolean; practice?: { address: string | null; probe: RefreshTokenProbe } }) {
  const address = useBrowserOrigin();
  const probe = useRefreshTokenProbe(Boolean(practice));
  return <ServerChecksView rows={plainServerChecks(inputs, practice ? practice.address : address, practice ? practice.probe : probe, desktop)} />;
}
export function ServerChecksView({ rows }: { rows: PlainCheck[] }) {
  const [restart, setRestart] = useState(false);
  return <><Text as="h2" size="heading">{checksHeadline(rows)}</Text><Section title="Checks"><ul className="divide-y divide-border/70 border-y border-border/70">{rows.map(row => <li className="grid gap-1 py-4 sm:grid-cols-[10rem_1fr]" key={row.name}><Text>{row.status === "error" || row.status === "warn" ? <span className="text-attention" aria-label="Needs attention">! </span> : null}{row.name}</Text><div className="grid gap-1"><Text color="muted">{row.sentence}</Text>{row.action ? row.href ? <Link className={buttonVariants({ variant: "ghost" })} href={row.href}>{row.action}</Link> : row.action === "Restart DataConnect." ? <IcButton className="w-fit" variant="ghost" onClick={() => setRestart(!restart)}>How to restart DataConnect</IcButton> : <Text color="muted">{row.action}</Text> : null}</div></li>)}</ul></Section>{restart ? <p role="status">On the computer that runs DataConnect, quit and reopen the app. If it runs as a service, ask whoever installed it to restart it.</p> : null}</>;
}
function TechnicalServerChecks({ inputs }: { inputs: ServerInputs }) {
  const browserOrigin = useBrowserOrigin();
  const refreshProbe = useRefreshTokenProbe();
  const [originAction, setOriginAction] = useState<"idle" | "copied" | "failed">("idle");

  const copyOrigin = () => {
    if (!browserOrigin || !navigator.clipboard?.writeText) {
      setOriginAction("failed");
      return;
    }
    void navigator.clipboard
      .writeText(`PDPP_REFERENCE_ORIGIN=${browserOrigin}`)
      .then(() => setOriginAction("copied"))
      .catch(() => setOriginAction("failed"));
  };

  const originRow = referenceOriginRow(
    inputs,
    browserOrigin,
    browserOrigin
      ? { label: originAction === "copied" ? "Origin copied" : "Use this origin", onClick: copyOrigin }
      : undefined
  );
  const rows: ReadinessRow[] = [
    ownerPasswordRow(inputs),
    originRow,
    storageBackendRow(inputs),
    embeddingCacheRow(inputs),
    refreshTokenRow(refreshProbe),
  ];

  return (
    <>
      <Section title="Checks">
        <ul className="divide-y divide-border/70 border-y border-border/70">
          {rows.map((row) => (
            <ReadinessRowItem key={row.check} row={row} />
          ))}
        </ul>
        <details className="mt-3">
          <summary className="min-h-11 cursor-pointer text-[13px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Details</summary>
          <p className="text-[13px] text-muted-foreground">Raw check details are shown above.</p>
        </details>
      </Section>
    </>
  );
}

export function serverAddressHeadline(row: ReadinessRow): string {
  switch (row.status) {
    case "ok": return "The server is reachable.";
    case "warn": return "The server address needs attention.";
    case "error": return "The server address is blocked.";
    case "info": return "The server address is not checked.";
    case "unknown": return "The server address is unknown.";
  }
}

function ReadinessRowItem({ row }: { row: ReadinessRow }) {
  const label = displayCheckName(row.check);
  const state = statusWords(row.status);

  return (
    <li className="grid min-w-0 gap-1 py-3 sm:grid-cols-[minmax(9rem,1fr)_minmax(0,2fr)_auto] sm:items-center sm:gap-4">
      <span className="text-[15px] font-medium text-foreground">{label}</span>
      <p className="text-[13px] text-muted-foreground">{state.sentence}</p>
      <span className={`text-[13px] ${state.tone}`}>{state.label}</span>
      {row.action ? (
        <div className="sm:col-start-2">
          <button className={buttonVariants({ className: "min-h-11 w-fit", size: "sm", variant: "ghost" })} onClick={row.action.onClick} type="button">
            {row.action.label}
          </button>
        </div>
      ) : null}
      <details className="sm:col-start-2">
        <summary className="min-h-11 cursor-pointer text-[13px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Details</summary>
        <p className="break-words text-[13px] text-muted-foreground">{row.detail}</p>
        {row.hint ? <p className="break-words text-[13px] text-muted-foreground">{row.hint}</p> : null}
      </details>
    </li>
  );
}

function displayCheckName(check: string): string {
  switch (check) {
    case "Owner password gate": return "Sign-in";
    case "Reference origin alignment": return "Server address";
    case "Storage backend": return "Storage";
    case "Embedding cache": return "Search setup";
    case "MCP refresh-token advertisement": return "App sign-in";
    default: return check;
  }
}

function statusWords(status: ReadinessRow["status"]): { label: string; sentence: string; tone: string } {
  switch (status) {
    case "ok": return { label: "Ready", sentence: "This check is ready.", tone: "text-foreground" };
    case "warn": return { label: "Needs attention", sentence: "This check needs attention.", tone: "text-attention" };
    case "error": return { label: "Blocked", sentence: "This check is blocked.", tone: "text-destructive" };
    case "info": return { label: "Info", sentence: "This is not a problem by itself.", tone: "text-muted-foreground" };
    case "unknown": return { label: "Checking", sentence: "This check is still loading.", tone: "text-muted-foreground" };
  }
}

const subscribeToAddress = () => () => {};
function useBrowserOrigin(): string | null {
  return useSyncExternalStore(subscribeToAddress, () => window.location.origin, () => null);
}

function useRefreshTokenProbe(skip = false): RefreshTokenProbe {
  const [probe, setProbe] = useState<RefreshTokenProbe>({ state: "loading" });
  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    void fetch("/.well-known/oauth-authorization-server", { cache: "no-store", credentials: "omit" })
      .then(async (response) => {
        if (!response.ok) {
          if (!cancelled) setProbe({ state: "unreachable" });
          return;
        }
        const body = (await response.json()) as { grant_types_supported?: unknown };
        const supported = Array.isArray(body.grant_types_supported) && body.grant_types_supported.includes("refresh_token");
        if (!cancelled) setProbe({ refreshTokenSupported: supported, state: "loaded" });
      })
      .catch(() => {
        if (!cancelled) setProbe({ state: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
  }, [skip]);
  return probe;
}
