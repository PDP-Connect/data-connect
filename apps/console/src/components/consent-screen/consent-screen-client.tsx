// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

/**
 * The consent screen — the page an owner uses to decide what an app may read.
 *
 * Built from the REAL `@pdpp/brand-react` components (IcButton, IcInput,
 * ConnectorIcon, Endorse) so there is zero drift by construction: this renders
 * the actual component modules the console's `/sources` and `/explore` pages
 * render, not a transcription of their output. `consent-screen.module.css`
 * supplies ONLY the structural rules those components have no equivalent for
 * (the sticky decision rail, the two-column grid, the mobile bottom-bar
 * collapse) — every value in it is a var(--token) reference into the same
 * tokens those components already use.
 *
 * Every fact on this page comes from the authorization server's consent
 * challenge (`ConsentScreenModel`). This component owns the SENTENCES; the
 * server owns the FACTS. Where only the server can know whether a statement
 * is true — what the client said its purpose was, whether it made a retention
 * promise — the statement itself arrives in the model and is rendered as-is.
 *
 * Connector icons come from each source's own manifest declaration, passed
 * straight to `ConnectorIcon`, which falls back to its Monogram for a
 * connector that declares none. There is no connector-id -> icon map here or
 * anywhere else.
 *
 * Preserves the owner feedback items from rounds 1-4 of the design task
 * (/home/tnunamak/code/pdpp/local/CONSENT-OWNER-FEEDBACK-0902.md): arbitrary
 * grant expiry with quick-fill chips, three trust tiers, keyboard-navigable
 * search, inline field disclosure, a sticky decision rail with duration folded
 * in, real platform icons, and two distinct date axes (grant validity vs
 * per-stream data range).
 */

import {
  ConnectorIcon,
  Endorse,
  IcButton,
  IcInput,
  IcPopover,
  IcPopoverClose,
  IcPopoverPopup,
  IcPopoverTrigger,
  IcTooltip,
  IcTooltipContent,
  IcTooltipTrigger,
} from "@pdpp/brand-react";
import { useMemo, useState } from "react";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import { ThemeToggle } from "@/components/theme/theme-toggle.tsx";
import styles from "./consent-screen.module.css";
import type {
  ConsentDecision,
  ConsentScreenModel,
  ConsentSourceModel,
  ConsentStreamModel,
  ConsentTrustTier,
} from "./consent-screen-model.ts";
import { clientPublishedLinks, sourceAccountLabel } from "./consent-screen-model.ts";

// Endorse's status vocabulary is written for GRANT state (active/expiring/
// revoked/...), not identity trust — reusing it here borrows its VISUAL chip
// pattern via the real `label` override, not its semantic meaning. The
// ordinal mapping (unknown -> continuous -> active) reads as ascending
// confidence without claiming a grant-lifecycle status that doesn't apply.
// A locally-scoped literal union, not an import of Endorse's own type, per
// the pattern every other console page already uses (e.g.
// (console)/event-subscriptions's subscriptionEndorseStatus()).
type TrustEndorseStatus = "active" | "continuous" | "unknown";
const TRUST_ENDORSE_STATUS: Record<ConsentTrustTier, TrustEndorseStatus> = {
  domain: "continuous",
  unverified: "unknown",
  verified: "active",
};
const TRUST_LABEL: Record<ConsentTrustTier, string> = {
  domain: "Domain verified",
  unverified: "Unverified",
  verified: "Verified",
};
const TRUST_HINT_ID = "consent-trust-explanation";

interface SelectionState {
  [sourceId: string]: {
    [streamName: string]: boolean;
  };
}

interface FieldSelectionState {
  [streamId: string]: {
    [fieldName: string]: boolean;
  };
}

/**
 * The server decides what starts checked (`stream.selected`), so a future
 * change to that policy is a server change, not a client one. Today it sends
 * nothing pre-selected: consent is an affirmative act, never a default the
 * owner has to notice and undo.
 */
function initialSelection(sources: readonly ConsentSourceModel[]): SelectionState {
  const state: SelectionState = {};
  for (const source of sources) {
    const streamState: Record<string, boolean> = {};
    for (const stream of source.streams) {
      streamState[stream.name] = stream.selected;
    }
    state[source.id] = streamState;
  }
  return state;
}

// A field picker starts with every manifest field selected. Required fields
// stay checked in the UI and the AS independently adds them back if a forged
// submission omits one; the UI is an honest view of that consent floor, not
// the authority that enforces it.
function initialFieldSelection(sources: readonly ConsentSourceModel[]): FieldSelectionState {
  const state: FieldSelectionState = {};
  for (const source of sources) {
    for (const stream of source.streams) {
      state[stream.id] = Object.fromEntries(stream.fields.map((field) => [field.name, true]));
    }
  }
  return state;
}

function todayPlusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const HUMAN_DATE_FMT = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" });

// One human format ("Dec 1, 2026") everywhere a date renders as text, so it
// never disagrees with the picker's own browser-native display next to it.
// The <input type="date"> element's `value` stays ISO — that's the HTML
// date-input contract, not a rendering choice.
function humanDate(iso: string): string {
  if (!iso) return "";
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return HUMAN_DATE_FMT.format(new Date(Date.UTC(year, month - 1, day)));
}

function fieldSummary(stream: ConsentStreamModel, selectedFields: number | null): string {
  if (stream.fieldsTotal === 0) {
    return "All fields";
  }
  return selectedFields === null || selectedFields === stream.fieldsTotal
    ? `All ${stream.fieldsTotal} fields`
    : `${selectedFields} of ${stream.fieldsTotal} fields`;
}

// DATA TIME RANGE (StreamGrant.time_constraint) — never grant validity.
function dataRangeSummary(stream: ConsentStreamModel, range: { since: string; until: string }): string {
  if (!stream.timePhrase) {
    return "";
  }
  if (range.since && range.until) {
    return `Data from ${humanDate(range.since)} to ${humanDate(range.until)}`;
  }
  if (range.since) {
    return `Data from ${humanDate(range.since)} onward`;
  }
  return "All dates";
}

function computeCounts(sources: readonly ConsentSourceModel[], selection: SelectionState) {
  let selectedStreamCount = 0;
  let totalStreamCount = 0;
  let selectedSourceCount = 0;
  for (const source of sources) {
    let sourceHasSelection = false;
    for (const stream of source.streams) {
      totalStreamCount += 1;
      if (selection[source.id]?.[stream.name]) {
        selectedStreamCount += 1;
        sourceHasSelection = true;
      }
    }
    if (sourceHasSelection) selectedSourceCount += 1;
  }
  return { selectedSourceCount, selectedStreamCount, totalStreamCount };
}

function ConsentHeader({ client }: { client: ConsentScreenModel["client"] }) {
  const publishedLinks = clientPublishedLinks(client.policyLinks);
  const trustExplanation =
    client.trust === "domain"
      ? `Verified automatically against the identity document published at ${client.domain}. No manual review.`
      : client.trust === "unverified"
        ? "Name and logo are self-reported. Nothing was verified."
        : "Confirmed by the operator of this server.";
  return (
    <header className={styles.consentHeader}>
      {/* `client.logo` is an AS-cached, same-origin URL — never the client's
          declared remote URI. The monogram remains the safe fallback for an
          unverified client or a logo fetch the AS could not approve. */}
      {client.logo ? (
        <img alt="" className={styles.clientLogo} src={client.logo} />
      ) : (
        <span className={`pdpp-monogram ${styles.clientMonogram}`} data-initials={client.monogram} />
      )}
      <div className={styles.consentHeaderContent}>
        <div className={styles.consentHeaderTitle}>
          <h1 className={`pdpp-display ${styles.headline}`}>{client.name} wants to read your data</h1>
          <span className={styles.trustHintDesktop}>
            <IcTooltip>
              <IcTooltipTrigger aria-describedby={TRUST_HINT_ID} aria-label={`${TRUST_LABEL[client.trust]}: ${trustExplanation}`} className={styles.trustHintTrigger}>
                <Endorse label={TRUST_LABEL[client.trust]} status={TRUST_ENDORSE_STATUS[client.trust]} />
              </IcTooltipTrigger>
              <IcTooltipContent id={TRUST_HINT_ID}>{trustExplanation}</IcTooltipContent>
            </IcTooltip>
          </span>
          <span className={styles.trustHintTouch}>
            <IcPopover>
              <IcPopoverTrigger aria-describedby={TRUST_HINT_ID} aria-label={`About ${TRUST_LABEL[client.trust]}`} className={styles.trustHintTrigger}>
                <Endorse label={TRUST_LABEL[client.trust]} status={TRUST_ENDORSE_STATUS[client.trust]} />
              </IcPopoverTrigger>
              <IcPopoverPopup id={TRUST_HINT_ID} aria-label={`${TRUST_LABEL[client.trust]} explanation`} role="tooltip">
                <p className="pdpp-caption">{trustExplanation}</p>
                <IcPopoverClose aria-label="Dismiss trust explanation" className={styles.trustHintDismiss}>
                  Dismiss
                </IcPopoverClose>
              </IcPopoverPopup>
            </IcPopover>
          </span>
        </div>
        <p className={`pdpp-caption ${styles.clientPublishedLinks}`}>
          {client.domain && <span>{client.domain} · </span>}
          {publishedLinks.length > 0
            ? publishedLinks.map((link, index) => (
                <span key={link.href}>
                  {index > 0 && " · "}
                  <a href={link.href} rel="noopener noreferrer nofollow" target="_blank">
                    {link.label}
                  </a>
                </span>
              ))
            : "No privacy policy or terms published."}
        </p>
        <p className="pdpp-body" style={{ color: "var(--muted-foreground)" }}>
          Choose what it can read. Anything you leave unchecked stays private.
        </p>
      </div>
    </header>
  );
}

function StreamRow({
  source,
  stream,
  selected,
  selectedFields,
  onToggleField,
  onSelectAll,
  onSelectNone,
  onToggle,
  ranges,
  setRange,
  applyRangeToAllSelected,
}: {
  applyRangeToAllSelected: (since: string, until: string) => void;
  onToggle: () => void;
  onToggleField: (fieldName: string, checked: boolean) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  ranges: Record<string, { since: string; until: string }>;
  selected: boolean;
  selectedFields: Record<string, boolean>;
  setRange: (sourceId: string, streamName: string, key: "since" | "until", value: string) => void;
  source: ConsentSourceModel;
  stream: ConsentStreamModel;
}) {
  const rangeKey = stream.id;
  const range = ranges[rangeKey] ?? { since: "", until: "" };

  return (
    <div className={styles.streamRow}>
      <input aria-label={`Share ${stream.label} from ${source.name}`} checked={selected} onChange={onToggle} type="checkbox" />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.1875rem", minWidth: 0 }}>
        <span className="pdpp-body">{stream.label}</span>
        <span className="pdpp-caption">{stream.sentence}</span>
        {selected && (
          <details className={styles.narrow}>
            <summary className={styles.narrowSummary}>
              {fieldSummary(
                stream,
                stream.fields.length > 0 ? stream.fields.filter((field) => selectedFields[field.name]).length : null
              )}{" "}
              {stream.fields.length > 0 && <span className={styles.narrowChange}>Change</span>}
            </summary>
            <div className={styles.narrowBody}>
              {stream.fields.length > 0 ? (
                <fieldset className={styles.fieldList}>
                  <legend className={`pdpp-caption ${styles.fieldPanelLegend}`}>
                    <span>Choose fields to share</span>
                    <span className={styles.fieldBulkActions}>
                      <button className={styles.fieldBulkAction} onClick={onSelectAll} type="button">Select all</button>
                      <span aria-hidden="true">·</span>
                      <button className={styles.fieldBulkAction} onClick={onSelectNone} type="button">Select none</button>
                    </span>
                  </legend>
                  {stream.fields.map((field) => (
                    <label className={styles.fieldOption} key={field.name}>
                      <input
                        checked={Boolean(selectedFields[field.name])}
                        disabled={field.required}
                        onChange={(event) => onToggleField(field.name, event.target.checked)}
                        type="checkbox"
                      />
                      <span>
                        <span className="pdpp-caption">{field.description || field.name}</span>
                        {field.description && <span className={styles.fieldRaw}>{field.name}</span>}
                        {field.required && <span className={styles.fieldRequired}>Required</span>}
                        {field.description && <span className="pdpp-caption">{field.description}</span>}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : (
                <p className="pdpp-caption">
                  {stream.fieldsTotal > 0
                    ? `This grant covers all ${stream.fieldsTotal} fields in ${stream.label.toLowerCase()}.`
                    : `This grant covers every field in ${stream.label.toLowerCase()}.`}
                </p>
              )}
              {stream.timePhrase ? (
                <div className={styles.streamRange}>
                  <span className="pdpp-caption">{dataRangeSummary(stream, range) || "All dates"}</span>
                  <label className="pdpp-caption">
                    from{" "}
                    <IcInput
                      aria-label={`${stream.timePhrase} since`}
                      onChange={(e) => setRange(source.id, stream.name, "since", e.target.value)}
                      style={{ width: "auto" }}
                      type="date"
                      value={range.since}
                    />
                  </label>
                  <label className="pdpp-caption">
                    to{" "}
                    <IcInput
                      aria-label={`${stream.timePhrase} until`}
                      onChange={(e) => setRange(source.id, stream.name, "until", e.target.value)}
                      style={{ width: "auto" }}
                      type="date"
                      value={range.until}
                    />
                  </label>
                  <button
                    className={styles.rangeApplyAll}
                    onClick={() => applyRangeToAllSelected(range.since, range.until)}
                    type="button"
                  >
                    Apply to all selected streams
                  </button>
                </div>
              ) : (
                <p className={`pdpp-caption ${styles.streamRange}`}>No date range for this data type.</p>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function SourceRow({
  source,
  selection,
  fieldSelection,
  ranges,
  hidden,
  active,
  searching,
  onToggleStream,
  onToggleField,
  onToggleSource,
  onSelectAll,
  onSelectNone,
  setRange,
  applyRangeToAllSelected,
}: {
  active: boolean;
  applyRangeToAllSelected: (since: string, until: string) => void;
  hidden: boolean;
  onToggleSource: (checked: boolean) => void;
  onToggleStream: (streamName: string) => void;
  onToggleField: (streamId: string, fieldName: string, checked: boolean) => void;
  onSelectAll: (streamId: string) => void;
  onSelectNone: (streamId: string) => void;
  fieldSelection: FieldSelectionState;
  ranges: Record<string, { since: string; until: string }>;
  searching: boolean;
  selection: SelectionState;
  setRange: (sourceId: string, streamName: string, key: "since" | "until", value: string) => void;
  source: ConsentSourceModel;
}) {
  const selected = source.streams.filter((s) => selection[source.id]?.[s.name]);
  const total = source.streams.length;
  const allSelected = selected.length === total && total > 0;
  const accountLabel = sourceAccountLabel(source.name, source.account);
  // Collapsed by default; open only for sources the request pre-selects. A
  // fixed initial state, not tied to live selection — checking a source
  // doesn't jump it open, unchecking doesn't collapse it. Reuses the same
  // <details> disclosure idiom as the per-stream narrowing one level down.
  // While a search is active, force every visible match open — a collapsed
  // row would hide the very stream text that matched the query.
  const initiallyOpen = source.streams.some((s) => s.selected);
  const [isOpen, setIsOpen] = useState(initiallyOpen);

  return (
    <details
      className={styles.sourceRow}
      data-active={active}
      data-hidden={hidden}
      hidden={hidden}
      key={searching ? "search" : "browse"}
      onToggle={(event) => {
        if (searching) {
          event.currentTarget.open = true;
          return;
        }
        setIsOpen(event.currentTarget.open);
      }}
      open={searching || isOpen}
    >
      <summary className={styles.sourceHead}>
        <span className={styles.sourceIcon}>
          <ConnectorIcon icon={source.icon ?? null} name={source.name} />
        </span>
        <span className={styles.sourceText}>
          {/* Layout in CSS, not inline: the account handle can only truncate
              if every flex ancestor is allowed to shrink below its content,
              which needs min-width:0 on this label too. */}
          <label className={styles.sourceLabel} onClick={(e) => e.stopPropagation()}>
            <input
              aria-label={`Share data from ${source.name}`}
              checked={allSelected}
              onChange={(e) => onToggleSource(e.target.checked)}
              ref={(el) => {
                if (el) el.indeterminate = selected.length > 0 && !allSelected;
              }}
              type="checkbox"
            />
            <span className={`pdpp-body ${styles.sourceName}`}>{source.name}</span>
            {accountLabel && <span className={`pdpp-caption ${styles.sourceAccount}`}>{accountLabel}</span>}
          </label>
        </span>
        <span className={styles.sourceCount}>
          {selected.length > 0 ? `${selected.length} of ${total}` : total} data types
        </span>
      </summary>
      <div className={styles.streamList}>
        {source.streams.map((stream) => (
          <StreamRow
            applyRangeToAllSelected={applyRangeToAllSelected}
            key={stream.name}
            onToggle={() => onToggleStream(stream.name)}
            onToggleField={(fieldName, checked) => onToggleField(stream.id, fieldName, checked)}
            onSelectAll={() => onSelectAll(stream.id)}
            onSelectNone={() => onSelectNone(stream.id)}
            ranges={ranges}
            selected={Boolean(selection[source.id]?.[stream.name])}
            selectedFields={fieldSelection[stream.id] ?? {}}
            setRange={setRange}
            source={source}
            stream={stream}
          />
        ))}
      </div>
    </details>
  );
}

export type ConsentSubmitState = "idle" | "submitting" | "failed";

export function ConsentScreen({
  acceptAction,
  model,
  rejectAction,
}: {
  /**
   * Records the approval and resolves to the client redirect the browser must
   * follow. Named `*Action` because these cross the client/server boundary as
   * Server Actions — Next.js enforces the suffix on a "use client" component's
   * non-serializable props.
   */
  acceptAction: (decision: ConsentDecision) => Promise<string>;
  model: ConsentScreenModel;
  rejectAction: () => Promise<string>;
}) {
  const [selection, setSelection] = useState<SelectionState>(() => initialSelection(model.sources));
  const [fieldSelection, setFieldSelection] = useState<FieldSelectionState>(() => initialFieldSelection(model.sources));
  const [ranges, setRanges] = useState<Record<string, { since: string; until: string }>>({});
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [expiry, setExpiry] = useState(() => {
    const preset = model.grantExpiry.options.find((option) => option.id === model.grantExpiry.defaultId);
    return preset?.days ? todayPlusDays(preset.days) : "";
  });
  const [noEndDate, setNoEndDate] = useState(false);
  const [activeChipDays, setActiveChipDays] = useState<number | null>(() => {
    const preset = model.grantExpiry.options.find((option) => option.id === model.grantExpiry.defaultId);
    return preset?.days ?? null;
  });
  const [submitState, setSubmitState] = useState<ConsentSubmitState>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const counts = useMemo(() => computeCounts(model.sources, selection), [model.sources, selection]);

  const query = search.trim().toLowerCase();
  const visibleSources = useMemo(() => {
    if (!query) return model.sources;
    return model.sources.filter((source) => {
      const text = [source.name, source.account, ...source.streams.map((s) => `${s.label} ${s.name}`)]
        .join(" ")
        .toLowerCase();
      return text.includes(query);
    });
  }, [model.sources, query]);

  function toggleStream(sourceId: string, streamName: string) {
    setSelection((prev) => ({
      ...prev,
      [sourceId]: { ...prev[sourceId], [streamName]: !prev[sourceId]?.[streamName] },
    }));
  }

  function toggleSource(sourceId: string, checked: boolean) {
    const source = model.sources.find((s) => s.id === sourceId);
    if (!source) return;
    setSelection((prev) => ({
      ...prev,
      [sourceId]: Object.fromEntries(source.streams.map((s) => [s.name, checked])),
    }));
  }

  function toggleField(streamId: string, fieldName: string, checked: boolean) {
    setFieldSelection((prev) => ({
      ...prev,
      [streamId]: { ...prev[streamId], [fieldName]: checked },
    }));
  }

  function selectFields(streamId: string, selectAll: boolean) {
    const stream = model.sources.flatMap((source) => source.streams).find((candidate) => candidate.id === streamId);
    if (!stream) return;
    setFieldSelection((prev) => ({
      ...prev,
      [streamId]: Object.fromEntries(stream.fields.map((field) => [field.name, selectAll || field.required])),
    }));
  }

  function setRange(sourceId: string, streamName: string, key: "since" | "until", value: string) {
    const rangeKey = `${sourceId}:${streamName}`;
    setRanges((prev) => ({
      ...prev,
      [rangeKey]: { since: prev[rangeKey]?.since ?? "", until: prev[rangeKey]?.until ?? "", [key]: value },
    }));
  }

  function applyRangeToAllSelected(since: string, until: string) {
    setRanges((prev) => {
      const next = { ...prev };
      for (const source of model.sources) {
        for (const stream of source.streams) {
          if (selection[source.id]?.[stream.name]) {
            next[stream.id] = { since, until };
          }
        }
      }
      return next;
    });
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1 >= visibleSources.length ? 0 : i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? visibleSources.length - 1 : i - 1));
    } else if (e.key === "Enter" && activeIndex >= 0 && visibleSources[activeIndex]) {
      e.preventDefault();
      const source = visibleSources[activeIndex];
      const allSelected = source.streams.every((s) => selection[source.id]?.[s.name]);
      toggleSource(source.id, !allSelected);
    } else if (e.key === "Escape") {
      setSearch("");
      setActiveIndex(-1);
    }
  }

  function endsText() {
    return noEndDate ? "No end date" : `Access ends ${humanDate(expiry)}`;
  }

  /**
   * The decision, in the shape the challenge API accepts. Only sources with at
   * least one chosen stream are included: a source checked but fully narrowed
   * to nothing is not a grant, and submitting it would make the server reject
   * the whole approval for an empty stream set.
   */
  function buildDecision(): ConsentDecision {
    const sources = model.sources
      .map((source) => {
        const chosen = source.streams.filter((stream) => selection[source.id]?.[stream.name]);
        return {
          sourceId: source.id,
          streamIds: chosen.map((stream) => stream.id),
          streamNames: chosen.map((stream) => stream.name),
        };
      })
      .filter((source) => source.streamNames.length > 0);

    // Only ranges belonging to a stream the owner actually kept, and only
    // where a bound was set. A leftover date on a stream that was later
    // unchecked is noise, not a narrowing, and an empty entry would ask the
    // server to record "no bound" as if it were one.
    const chosenStreamIds = new Set(sources.flatMap((source) => source.streamIds));
    const streamFields: Record<string, readonly string[]> = {};
    const streamRanges: Record<string, { since?: string; until?: string }> = {};
    for (const [streamId, range] of Object.entries(ranges)) {
      if (!chosenStreamIds.has(streamId)) {
        continue;
      }
      const entry: { since?: string; until?: string } = {};
      if (range.since) {
        entry.since = range.since;
      }
      if (range.until) {
        entry.until = range.until;
      }
      if (entry.since || entry.until) {
        streamRanges[streamId] = entry;
      }
    }

    for (const source of model.sources) {
      for (const stream of source.streams) {
        if (!chosenStreamIds.has(stream.id) || stream.fields.length === 0) {
          continue;
        }
        streamFields[stream.id] = stream.fields
          .filter((field) => fieldSelection[stream.id]?.[field.name])
          .map((field) => field.name);
      }
    }

    return {
      accessMode: model.accessMode.value,
      grantExpiry: noEndDate ? "never" : expiry,
      reviewDigest: model.reviewDigest,
      sources,
      streamFields,
      streamRanges,
    };
  }

  async function submit(action: "accept" | "reject") {
    setSubmitState("submitting");
    setSubmitError(null);
    try {
      const redirectUrl = action === "accept" ? await acceptAction(buildDecision()) : await rejectAction();
      // The OAuth flow ends at the CLIENT's origin, so this is a full document
      // navigation off the console, not a router push. `replace` keeps the
      // consumed challenge out of history — going Back must not re-present a
      // decision the owner has already made.
      window.location.replace(redirectUrl);
    } catch (err) {
      setSubmitState("failed");
      setSubmitError(err instanceof Error ? err.message : "Something went wrong. Nothing was shared.");
    }
  }

  const nothingChosen = counts.selectedStreamCount === 0;
  const busy = submitState === "submitting";

  return (
    <div className={styles.page}>
      <ConsentHeader client={model.client} />
      <div className={styles.grid}>
        <div className={styles.body}>
          <div className="pdpp-sheet" style={{ padding: "1.25rem" }}>
            <h2 className="pdpp-title">Terms</h2>
            <p className="pdpp-body">{model.purpose.description}</p>
            {/* Italic muted caption marks this server's OWN statement about the
                client, distinct from anything the client authored — the same
                convention this design system uses elsewhere for
                system-generated text. */}
            <p className="pdpp-caption" style={{ fontStyle: "italic", marginTop: "0.5rem" }}>
              {model.retention}
            </p>
          </div>

          <div className={styles.mobileExpiry}>
            <GrantExpiryControls
              activeChipDays={activeChipDays}
              expiry={expiry}
              options={model.grantExpiry.options}
              noEndDate={noEndDate}
              setActiveChipDays={setActiveChipDays}
              setExpiry={setExpiry}
              setNoEndDate={setNoEndDate}
            />
          </div>

          <div>
            <div style={{ alignItems: "baseline", display: "flex", justifyContent: "space-between" }}>
              <h2 className="pdpp-title">What it can read</h2>
              <span className="pdpp-caption">{model.sources.length} sources</span>
            </div>
            {model.sources.length === 0 ? (
              <div className={styles.searchEmpty}>
                You have no connected sources yet, so there is nothing to share. Connect a source first, then start this
                request again.
              </div>
            ) : (
              <>
                <div className={styles.searchRow}>
                  <IcInput
                    aria-label="Search sources"
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setActiveIndex(-1);
                    }}
                    onKeyDown={onSearchKeyDown}
                    placeholder="Search sources"
                    type="search"
                    value={search}
                  />
                  {search && (
                    <button
                      className={styles.searchClear}
                      onClick={() => {
                        setSearch("");
                        setActiveIndex(-1);
                      }}
                      type="button"
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className={styles.searchCount}>
                  {query
                    ? `${visibleSources.length} of ${model.sources.length} sources match`
                    : `${visibleSources.length} sources`}
                </div>
                {visibleSources.length === 0 && (
                  <div className={styles.searchEmpty}>
                    No sources match &ldquo;{search}&rdquo;. Clear the search to see everything.
                  </div>
                )}
                {model.sources.map((source) => {
                  const isHidden = !visibleSources.includes(source);
                  const visibleIndex = visibleSources.indexOf(source);
                  return (
                    <SourceRow
                      active={visibleIndex >= 0 && visibleIndex === activeIndex}
                      applyRangeToAllSelected={applyRangeToAllSelected}
                      fieldSelection={fieldSelection}
                      hidden={isHidden}
                      key={source.id}
                      onToggleSource={(checked) => toggleSource(source.id, checked)}
                      onToggleField={toggleField}
                      onSelectAll={(streamId) => selectFields(streamId, true)}
                      onSelectNone={(streamId) => selectFields(streamId, false)}
                      onToggleStream={(streamName) => toggleStream(source.id, streamName)}
                      ranges={ranges}
                      searching={Boolean(query)}
                      selection={selection}
                      setRange={setRange}
                      source={source}
                    />
                  );
                })}
              </>
            )}
          </div>
        </div>

        <aside aria-label="What you're allowing" className={styles.rail}>
          <div className={styles.railSummary}>
            <strong>{counts.selectedSourceCount}</strong> sources · <strong>{counts.selectedStreamCount}</strong> of{" "}
            {counts.totalStreamCount} streams selected
          </div>
          <p className={styles.railMobileSummary}>
            {endsText()} · {counts.selectedStreamCount} {counts.selectedStreamCount === 1 ? "stream" : "streams"}
          </p>
          <GrantExpiryControls
            activeChipDays={activeChipDays}
            expiry={expiry}
            options={model.grantExpiry.options}
            noEndDate={noEndDate}
            setActiveChipDays={setActiveChipDays}
            setExpiry={setExpiry}
            setNoEndDate={setNoEndDate}
          />
          {/* Where the browser actually goes, which is a different fact from
              the identity the client proved — so it names the redirect host,
              not the app. */}
          {model.client.returnTo && <p className={styles.railReturnTo}>You'll return to {model.client.returnTo}</p>}
          {submitError && (
            <p className={styles.railEnds} role="alert">
              {submitError}
            </p>
          )}
          <div className={styles.railActions}>
            <IcButton
              disabled={busy || nothingChosen}
              onClick={() => submit("accept")}
              type="button"
              variant="human"
            >
              {busy ? "Working…" : "Allow access"}
            </IcButton>
            <IcButton disabled={busy} onClick={() => submit("reject")} type="button" variant="ghost">
              Cancel
            </IcButton>
          </div>
          {nothingChosen && <p className="pdpp-caption">Choose at least one data type to allow access.</p>}
          <div className={styles.railFooterRow}>
            <a className={styles.railFooter} href="https://pdpp.dev">
              <PdppLogo size={14} />
              <span className="pdpp-caption">Secured by PDPP</span>
            </a>
            <ThemeToggle />
          </div>
        </aside>
      </div>
    </div>
  );
}

// One composed control, not a picker plus a redundant echo: the summary line
// only appears when it says something the picker itself can't — "No end date"
// disables and greys the date input, so that state needs a plain-text
// confirmation the picker alone doesn't give.
function GrantExpiryControls({
  expiry,
  setExpiry,
  noEndDate,
  setNoEndDate,
  activeChipDays,
  setActiveChipDays,
  options,
}: {
  activeChipDays: number | null;
  expiry: string;
  noEndDate: boolean;
  options: ConsentScreenModel["grantExpiry"]["options"];
  setActiveChipDays: (v: number | null) => void;
  setExpiry: (v: string) => void;
  setNoEndDate: (v: boolean) => void;
}) {
  // Quick-fill chips come from the server's own bounded option set, so the
  // page cannot offer a duration the accept route would reject. The bare date
  // input still accepts any date the server's bounds allow.
  const chips = options.filter((option): option is typeof option & { days: number } => option.days !== null);
  const allowsNever = options.some((option) => option.days === null);

  return (
    <div className={styles.grantExpiry}>
      <span className="pdpp-eyebrow">Access duration</span>
      <div className={styles.grantExpiryRow}>
        <IcInput
          aria-label="Access ends"
          disabled={noEndDate}
          onChange={(e) => {
            setExpiry(e.target.value);
            setActiveChipDays(null);
          }}
          style={{ width: "auto" }}
          type="date"
          value={expiry}
        />
        {chips.map((option) => (
          <button
            aria-pressed={activeChipDays === option.days}
            className={styles.chip}
            key={option.id}
            onClick={() => {
              setNoEndDate(false);
              setActiveChipDays(option.days);
              setExpiry(todayPlusDays(option.days));
            }}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      {allowsNever && (
        <label className={styles.noEndDate}>
          <input
            checked={noEndDate}
            onChange={(e) => {
              setNoEndDate(e.target.checked);
              setActiveChipDays(null);
            }}
            type="checkbox"
          />
          No end date
        </label>
      )}
      {noEndDate && <p className={styles.railEnds}>Access never expires.</p>}
    </div>
  );
}
