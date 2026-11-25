"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import { useEffect, useState } from "react";
import {
  embeddingCacheRow,
  overallVerdict,
  ownerPasswordRow,
  type ReadinessRow,
  referenceOriginRow,
  refreshTokenRow,
  type RefreshTokenProbe,
  type ServerInputs,
  storageBackendRow,
} from "../components/deployment-readiness-rows.ts";

export function ServerChecks({ inputs }: { inputs: ServerInputs }) {
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

  const rows: ReadinessRow[] = [
    ownerPasswordRow(inputs),
    referenceOriginRow(
      inputs,
      browserOrigin,
      browserOrigin
        ? { label: originAction === "copied" ? "Origin copied" : "Use this origin", onClick: copyOrigin }
        : undefined
    ),
    storageBackendRow(inputs),
    embeddingCacheRow(inputs),
    refreshTokenRow(refreshProbe),
  ];

  return (
    <Section title="Checks">
      <ul className="divide-y divide-border/70 border-y border-border/70">
        {rows.map((row) => (
          <ReadinessRowItem key={row.check} row={row} />
        ))}
      </ul>
      <details className="mt-3">
        <summary className="min-h-11 cursor-pointer text-[13px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Details</summary>
        <p className="text-[13px] text-muted-foreground">{summaryWords(overallVerdict(rows))}</p>
      </details>
    </Section>
  );
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

function summaryWords(verdict: ReturnType<typeof overallVerdict>): string {
  switch (verdict) {
    case "ready": return "All five checks are ready.";
    case "attention": return "Some checks need attention. See each row.";
    case "blocked": return "At least one check is blocked.";
    case "unknown": return "Some checks are still loading.";
  }
}

function useBrowserOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  return origin;
}

function useRefreshTokenProbe(): RefreshTokenProbe {
  const [probe, setProbe] = useState<RefreshTokenProbe>({ state: "loading" });
  useEffect(() => {
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
  }, []);
  return probe;
}
