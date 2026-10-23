"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import React from "react";
import { Button } from "../../ui/button.tsx";
import { Timestamp } from "../../ui/timestamp.tsx";

const ISO_DATE_OR_DATETIME_RE = /^\d{4}-\d{2}-\d{2}([T ].+)?$/;

// Render a timestamp-ish string: if it parses as a real Date, use the
// interactive <Timestamp> component (human-readable + tooltip w/ full
// detail); otherwise render it verbatim. Lets pre-formatted specimen
// strings like 'Apr 15, 2026' pass through untouched while real ISO
// values get the full treatment.
function DateLike({ value }: { value: string | null | undefined }) {
  if (value === null || value === undefined || value === "") {
    return <>Never</>;
  }
  const looksISO = ISO_DATE_OR_DATETIME_RE.test(value);
  const parsed = looksISO ? new Date(value) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return <Timestamp mode="absolute" precision="date" value={value} />;
  }
  return <>{value}</>;
}

const GROUP_EYEBROW = {
  client: "They claim — not verified by your server",
  declared: "The app declared this — your server does not enforce it",
  protocol: "Your server enforces",
} as const;

function GrantGroup({
  authorship,
  children,
}: {
  authorship: keyof typeof GROUP_EYEBROW;
  children: React.ReactNode;
}) {
  return (
    <div
      className="mt-3 border-l-2 pl-3"
      data-authorship={authorship}
      style={{
        borderLeftColor: authorship === "protocol" ? "var(--primary)" : "var(--muted-foreground)",
        borderLeftStyle: authorship === "protocol" ? "solid" : authorship === "declared" ? "dotted" : "dashed",
      }}
    >
      <div className="mb-1 text-xs" data-slot="authorship-eyebrow" style={{ color: "var(--muted-foreground)" }}>
        {GROUP_EYEBROW[authorship]}
      </div>
      {children}
    </div>
  );
}

function GrantTerm({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
        {label}
      </div>
      <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
        {children}
      </div>
    </div>
  );
}

// ─── Grant Inspector ─────────────────────────────────────────────────────────

// Props contract — provenance of each field (see spec §7 Grant):
//
// Three groups, never one list (spec-core.md section 6):
//   ENFORCED (protocol): grantId, issuedAt, status, accessMode, expiresAt,
//     streams[]. The server holds and applies these.
//   DECLARED: purposeCode, purposeDescription, retention. Structured policy
//     the app declared. The server records it but does not enforce it
//     (spec-core.md section 7: retention is not technically enforced).
//   CLIENT CLAIMS: client.name, which comes from client_display at consent
//     time and is self-described.
//
// FROM manifest display metadata (server-trusted):
//   streams[].label, streams[].detail
//
// FROM server policy:
//   status (active/expired/revoked) — tracked by AS, not in grant

export interface GrantStream {
  detail?: string; // manifest display.detail
  fields?: string[]; // granted field allowlist, absent = all
  label: string; // manifest display.label
  name: string;
  timeRange?: { since?: string; until?: string };
  view?: string; // informational — which view was selected
}

export interface GrantInspectorProps {
  accessMode: "continuous" | "single_use";
  client: {
    clientId: string;
    name: string; // from client_display at consent time, or client_id
  };
  expiresAt?: string | null; // human-readable date, null = no expiry
  grantId: string;
  issuedAt: string; // human-readable date
  onRevoke?: () => void;
  purposeCode: string;
  purposeDescription?: string;
  retention?: {
    duration: string; // human-readable, e.g. "90 days"
    onExpiry: "delete" | "anonymize";
  };
  status: "active" | "expired" | "revoked";
  streams: GrantStream[];
}

export function GrantInspector({
  grantId,
  issuedAt,
  status,
  client,
  purposeCode,
  purposeDescription,
  accessMode,
  expiresAt,
  retention,
  streams,
  onRevoke,
}: GrantInspectorProps) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const toggleExpand = (key: string) => setExpanded((v) => ({ ...v, [key]: !v[key] }));
  const [revoked, setRevoked] = React.useState(status === "revoked");
  const currentStatus = revoked ? "revoked" : status;

  const statusColor = {
    active: "var(--success)",
    expired: "var(--muted-foreground)",
    revoked: "var(--destructive)",
  }[currentStatus];

  const statusLabel = {
    active: accessMode === "continuous" ? "Active, ongoing" : "Active, single use",
    expired: "Expired",
    revoked: "Revoked",
  }[currentStatus];

  const accessModeLabel =
    accessMode === "continuous" ? "Continuous access, until it expires or you revoke it" : "Single use";

  return (
    <div style={{ maxWidth: "440px" }}>
      <div className="overflow-hidden rounded-xl" data-surface="protocol">
        {/* ── Header: grant identity + status ── */}
        <div className="px-5 pt-5 pb-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: statusColor }} />
              <span className="font-medium text-xs" style={{ color: statusColor }}>
                {statusLabel}
              </span>
            </div>
            <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
              {grantId}
            </span>
          </div>

          {/* Group 1: enforced. Facts the owner's server holds and applies. */}
          <GrantGroup authorship="protocol">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <GrantTerm label="Issued">
                <span className="font-mono">
                  <DateLike value={issuedAt} />
                </span>
              </GrantTerm>
              <GrantTerm label="Expires">
                <span className="font-mono">
                  <DateLike value={expiresAt ?? null} />
                </span>
              </GrantTerm>
              <GrantTerm label="Access">{accessModeLabel}</GrantTerm>
            </div>
          </GrantGroup>

          {/* Group 2: declared. Structured policy the app declared; the server does not enforce it. */}
          <GrantGroup authorship="declared">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <GrantTerm label="Purpose code">
                <span className="font-mono">{purposeCode}</span>
              </GrantTerm>
              {purposeDescription && <GrantTerm label="Purpose description">{purposeDescription}</GrantTerm>}
              {retention && (
                <GrantTerm label="Retention">
                  The app says it will {retention.onExpiry === "delete" ? "delete" : "anonymize"} the data after{" "}
                  {retention.duration}
                </GrantTerm>
              )}
            </div>
          </GrantGroup>

          {/* Group 3: client claims. How the app describes itself. */}
          <GrantGroup authorship="client">
            <GrantTerm label="App name">{client.name}</GrantTerm>
          </GrantGroup>
        </div>

        {/* ── Granted streams ── */}
        <div className="px-5 pb-1" style={{ borderTop: "1px solid var(--border)" }}>
          {streams.map(({ name, label, detail, fields, view, timeRange }) => (
            <div key={name} style={{ borderBottom: "1px solid var(--border)" }}>
              <button
                aria-expanded={!!expanded[name]}
                className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
                // biome-ignore lint/performance/noJsxPropsBind: Handler captures the current row or component state; extracting it would add indirection without a stable consumer boundary.
                onClick={() => toggleExpand(name)}
                type="button"
              >
                <span className="font-medium text-xs" style={{ color: "var(--foreground)" }}>
                  {label}
                </span>
                <span
                  className="shrink-0 text-xs"
                  style={{
                    color: "var(--muted-foreground)",
                    display: "inline-block",
                    transform: expanded[name] ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 150ms",
                  }}
                >
                  &#x203A;
                </span>
              </button>
              {expanded[name] && (
                <div
                  className="flex flex-col gap-1 border-l-2 pb-2.5 pl-3"
                  style={{ borderColor: "oklch(0.580 0.172 253.7 / 0.25)" }}
                >
                  {detail && (
                    <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                      {detail}
                    </div>
                  )}
                  {view && (
                    <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                      <span style={{ opacity: 0.7 }}>View: </span>
                      <span className="rounded px-1 py-px" style={{ backgroundColor: "var(--muted)" }}>
                        {view}
                      </span>
                    </div>
                  )}
                  {fields && (
                    <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                      <span style={{ opacity: 0.7 }}>Fields: </span>
                      {fields.join(", ")}
                    </div>
                  )}
                  {timeRange?.since && (
                    <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                      <span style={{ opacity: 0.7 }}>Since: </span>
                      {timeRange.since}
                    </div>
                  )}
                  {!(fields || view) && (
                    <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                      All fields authorized
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── Revoke action ── */}
        {currentStatus === "active" && onRevoke && (
          <div className="px-5 py-4">
            <Button
              className="w-full"
              // biome-ignore lint/performance/noJsxPropsBind: Handler captures the current row or component state; extracting it would add indirection without a stable consumer boundary.
              onClick={() => {
                setRevoked(true);
                onRevoke();
              }}
              style={{ borderColor: "var(--destructive)", color: "var(--destructive)" }}
              variant="outline"
            >
              Revoke access
            </Button>
          </div>
        )}

        {currentStatus !== "active" && (
          <div className="px-5 py-3 text-center text-xs" style={{ color: "var(--muted-foreground)" }}>
            {currentStatus === "revoked"
              ? "Access has been revoked. No further queries will be served."
              : "This grant has expired. No further queries will be served."}
          </div>
        )}
      </div>
      {revoked && status !== "revoked" && (
        <button
          className="mt-2 px-0.5 font-mono text-xs"
          // biome-ignore lint/performance/noJsxPropsBind: Handler captures the current row or component state; extracting it would add indirection without a stable consumer boundary.
          onClick={() => setRevoked(false)}
          style={{ color: "var(--muted-foreground)" }}
          type="button"
        >
          ↺ reset
        </button>
      )}
    </div>
  );
}
