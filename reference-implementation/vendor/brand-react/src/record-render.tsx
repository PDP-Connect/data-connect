// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record renderer — the ONE record body for the whole console.
 *
 * Ported from the Recordroom design (`rr-record.jsx`) and rebound to the REAL
 * record shape. `RecordBody` is the single record renderer — Explore's
 * inspector, Sources' previews, and everywhere a record is shown compose this.
 *
 * `RecordBody` presents the data as plain label/value rows. Callers render
 * server-declared files and relationships because they own those links.
 */
import "./components.css";
import {
  type DeclaredFieldTypes,
  labelFor,
  resolveFieldValue,
} from "./record-fields.ts";

// ─── RecordField — a human label and readable value ────────────────

interface RecordFieldProps {
  /**
   * The declared presentation type for this field (drives money formatting).
   * Passed straight through to `resolveFieldValue`, whose own parameter is
   * `string | undefined` (a plain lookup result, e.g. `declaredTypes[k]`) —
   * "absent" and "present but undefined" are the same "no declared type" all
   * the way down, so the type says so here too.
   */
  declaredType?: string | undefined;
  /** The wire key — what a client literally receives. Mono voice. */
  fieldKey: string;
  /** The raw value from `data`. */
  value: unknown;
}

/**
 * One field row: a curated or humanized label and its value.
 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const WEB_LINK_RE = /^https?:\/\//i;

function recordValueText(value: unknown, declaredType: string | undefined): string {
  if (typeof value === "string" && (DATE_ONLY_RE.test(value) || ISO_DATETIME_RE.test(value))) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      const options: Intl.DateTimeFormatOptions = DATE_ONLY_RE.test(value)
        ? { dateStyle: "medium", timeZone: "UTC" }
        : { dateStyle: "medium", timeStyle: "short" };
      return new Intl.DateTimeFormat(undefined, options).format(date);
    }
  }
  return resolveFieldValue(value, declaredType).text;
}

/** One plain field row with a human label and a readable value. */
export function RecordField({ fieldKey, value, declaredType }: RecordFieldProps) {
  const resolved = resolveFieldValue(value, declaredType);
  const text = recordValueText(value, declaredType);
  const valClass = ["rr-fld__val", resolved.money ? "is-num" : undefined, resolved.empty ? "is-empty" : undefined]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="rr-fld">
      <span className="rr-fld__label">{labelFor(fieldKey)}</span>
      <span className={valClass}>
        {typeof value === "string" && WEB_LINK_RE.test(value) ? (
          <a href={value} rel="noreferrer" target="_blank">{text}</a>
        ) : text}
      </span>
    </div>
  );
}

// ─── RecordBody — kind-aware record renderer ──────────────────────

/**
 * Server-declared blob affordance for a record — the SAME shape operator-ui's
 * `buildBlobAffordance` produces (`ExplorerBlobAffordance`). Declared here as a
 * structural type so the framework-light ink-carbon kit does not depend on
 * operator-ui; callers pass the already-computed affordance straight through.
 */
export interface RecordBlobAffordance {
  fieldName: string;
  href?: string;
  reason?: string;
  state: "available" | "unavailable";
}

interface RecordBodyProps {
  /**
   * Server-declared blob/image for this record (from `field_capabilities` via
   * `buildBlobAffordance`). When supplied and available it is the PRIMARY image
   * source; the heuristic `findImageField` is only used when this is absent.
   */
  blobAffordance?: RecordBlobAffordance;
  className?: string;
  /** The record's `data` payload — where ALL real fields live. */
  data: Record<string, unknown>;
  /** Declared field types from `field_capabilities` (money detection). */
  declaredTypes?: DeclaredFieldTypes;
  /** The record kind, retained for compatibility with existing call sites. */
  stream: string;
}

export function RecordBody({ data, declaredTypes = {}, className, blobAffordance }: RecordBodyProps) {
  const fields = Object.entries(data).filter(([key]) => key !== blobAffordance?.fieldName);
  if (fields.length === 0) {
    return <div className={["rr-recbody", className].filter(Boolean).join(" ")}><p className="rr-recbody__empty">No fields to show.</p></div>;
  }
  return (
    <div className={["rr-recbody", className].filter(Boolean).join(" ")}>
      <div className="rr-flds">
        {fields.map(([key, value]) => <RecordField declaredType={declaredTypes[key]} fieldKey={key} key={key} value={value} />)}
      </div>
    </div>
  );
}

// The pure record helpers (labelFor, kindOf, displayTitle, resolveFieldValue,
// etc.) are NOT re-exported here — import them from "./record-fields.ts" or the
// kit barrel `index.ts`, which surfaces them directly. This file exports only
// the React renderers, keeping the module graph flat.
