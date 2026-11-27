// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

/**
 * The consent screen — the page an owner uses to decide what an app may read.
 *
 * Built from the REAL `@pdpp/brand-react` components (IcButton, IcInput,
 * Endorse) so there is zero drift by construction: this renders
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
 * Connector marks use the resolved connector identity and optional icon from
 * the server. Source IDs and opaque grant-selection values remain separate.
 * Older servers without display identity retain their explicit-icon fallback.
 *
 * Per owner feedback rounds 1-4 (2026-09-02): arbitrary grant expiry with
 * quick-fill chips, three trust tiers, keyboard-navigable search, inline field
 * disclosure, a sticky decision rail with duration folded in, real platform
 * icons, and two distinct date axes (grant validity vs per-stream data range).
 */

import { buttonVariants, IcButton, IcInput } from "@pdpp/brand-react";
import { Button } from "@pdpp/operator-ui/ui/button";
import { useEffect, useMemo, useState } from "react";
import { CalendarDateInput } from "@/app/(console)/history/calendar-date-input.tsx";
import { isOwnerRecordKind } from "@/app/(console)/lib/source-record-label.ts";
import { ConnectorMark } from "@/app/(console)/components/connector-mark.tsx";
import styles from "./consent-screen.module.css";
import type {
  ConsentActionResult,
  ConsentDecision,
  ConsentScreenModel,
  ConsentSourceModel,
  ConsentStreamModel,
} from "./consent-screen-model.ts";
import { clientPublishedLinks, sourceAccountLabel } from "./consent-screen-model.ts";

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

const HUMAN_DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

// One human format ("Dec 1, 2026") everywhere a date renders as text, so it
// never disagrees with the picker's own browser-native display next to it.
// The <input type="date"> element's `value` stays ISO — that's the HTML
// date-input contract, not a rendering choice.
function humanDate(iso: string): string {
  if (!iso) {
    return "";
  }
  const [year, month, day] = iso.split("-").map(Number);
  if (!(year && month && day)) {
    return iso;
  }
  return HUMAN_DATE_FMT.format(new Date(Date.UTC(year, month - 1, day)));
}


function humanFieldName(name: string): string {
  return name
    .replace(/[_-]+/gu, " ")
    .replace(/\bid\b/giu, "identifier")
    .replace(/\b\w/gu, (letter) => letter.toLocaleUpperCase());
}

function plainCopy(value: string): string {
  return value
    .replace(/\bMCP client\b/giu, "app")
    .replace(/\bclients?\b/giu, "app")
    .replace(/\bscopes?\b/giu, "what it can read")
    .replace(/\bgrants?\b/giu, "access")
    .replace(/\bstreams?\b/giu, (word) => (word.toLowerCase() === "stream" ? "kind of record" : "kinds of records"))
    .replace(/\btokens?\b/giu, "access details")
    .replace(/\bOAuth\b/giu, "sign-in")
    .replace(/\bPKCE\b/giu, "secure sign-in check")
    .replace(/\bchallenge\b/giu, "request")
    .replace(/\b([A-Za-z]+)_([A-Za-z]+)\b/gu, "$1 $2");
}

function sourceCountPhrase(count: number): string {
  return count === 1 ? "1 kind of record" : `${count} kinds of records`;
}

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
  if (range.until) {
    return `Data through ${humanDate(range.until)}`;
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
    if (sourceHasSelection) {
      selectedSourceCount += 1;
    }
  }
  return { selectedSourceCount, selectedStreamCount, totalStreamCount };
}

function ConsentHeader({ client }: { client: ConsentScreenModel["client"] }) {
  const verified = client.trust === "domain";
  return (
    <header className={styles.consentHeader}>
      {/* `client.logo` is an AS-cached, same-origin URL — never the client's
          declared remote URI. The monogram remains the safe fallback for an
          unverified client or a logo fetch the AS could not approve. */}
      {client.logo ? (
        <img alt="" className={styles.clientLogo} src={client.logo} />
      ) : (
        <ConnectorMark connectorId={client.name.toLowerCase()} name={client.name} />
      )}
      <div className={styles.consentHeaderContent}>
        <div className={styles.consentHeaderTitle}>
          <h1 className={`pdpp-display ${styles.headline}`}>{client.name} wants to read your data</h1>
        </div>
        <div className={styles.trustLine}>
          <span>{client.returnTo}</span>
          {verified ? null : <span>not verified</span>}
        </div>
        {verified ? <p className="pdpp-caption">The name is what the app calls itself.</p> : (
          <p className="pdpp-body text-attention">
            DataConnect could not confirm who runs this app. Allow it only if you started this from{" "}
            {client.returnTo || "the app"} yourself.
          </p>
        )}
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
}: {
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
  const [limiting, setLimiting] = useState(false);
  const rangeKey = stream.id;
  const sinceInputId = `consent-${stream.id}-since`;
  const untilInputId = `consent-${stream.id}-until`;
  const range = ranges[rangeKey] ?? { since: "", until: "" };

  return (
    <div className={styles.streamRow}>
      <input
        aria-label={`Share ${stream.label} from ${source.name}`}
        checked={selected}
        onChange={onToggle}
        type="checkbox"
      />
      <div className={styles.streamContent}>
        <span className="pdpp-body">{stream.label}</span>
        <span className="pdpp-caption">{plainCopy(stream.sentence)}</span>
        {selected ? (
          <Button
            aria-expanded={limiting}
            onClick={() => setLimiting((value) => !value)}
            size="sm"
            type="button"
            variant="link"
          >
            Limit what it sees
          </Button>
        ) : null}
        {selected && limiting && (
          <div className={styles.narrow}>
            <div className={styles.narrowBody}>
              {stream.fields.length > 0 ? (
                <fieldset className={styles.fieldList}>
                  <legend className={`pdpp-caption ${styles.fieldPanelLegend}`}>
                    <span className="sr-only">Fields</span>
                    <span className={styles.fieldBulkActions}>
                      <button className={styles.fieldBulkAction} onClick={onSelectAll} type="button">
                        Select all
                      </button>
                      <span aria-hidden="true">·</span>
                      <button className={styles.fieldBulkAction} onClick={onSelectNone} type="button">
                        Select none
                      </button>
                    </span>
                  </legend>
                  <p className="pdpp-caption">Each record’s id is always included.</p>
                  {stream.fields
                    .filter((field) => !["id","record_id"].includes(field.name))
                    .map((field) => (
                      <label className={styles.fieldOption} key={field.name}>
                        <input
                          checked={Boolean(selectedFields[field.name])}
                          disabled={field.required}
                          onChange={(event) => onToggleField(field.name, event.target.checked)}
                          type="checkbox"
                        />
                        <span>
                          <span className="pdpp-caption">{plainCopy(field.label || humanFieldName(field.name))}</span>
                          {field.required && <span className={styles.fieldRequired}>Always included</span>}
                          {field.description && <span className="pdpp-caption">{plainCopy(field.description)}</span>}
                        </span>
                      </label>
                    ))}
                </fieldset>
              ) : (
                <p className="pdpp-caption">
                  {stream.fieldsTotal > 0
                    ? `This request includes all ${stream.fieldsTotal} fields in ${stream.label.toLowerCase()}.`
                    : `This request includes every field in ${stream.label.toLowerCase()}.`}
                </p>
              )}
              {stream.timePhrase ? (
                <div className={styles.streamRange}>
                  {range.since || range.until ? (
                    <span className="pdpp-caption">{dataRangeSummary(stream, range)}</span>
                  ) : null}

                  <label className="pdpp-caption" htmlFor={sinceInputId}>
                    From
                  </label>
                  <CalendarDateInput
                    aria-label={`${stream.timePhrase} since`}
                    className={styles.dateInput}
                    id={sinceInputId}
                    onChange={(e) => setRange(source.id, stream.name, "since", e.target.value)}
                    value={range.since}
                  />
                  <label className="pdpp-caption" htmlFor={untilInputId}>
                    To
                  </label>
                  <CalendarDateInput
                    aria-label={`${stream.timePhrase} until`}
                    className={styles.dateInput}
                    id={untilInputId}
                    onChange={(e) => setRange(source.id, stream.name, "until", e.target.value)}
                    value={range.until}
                  />
                </div>
              ) : (
                <p className={`pdpp-caption ${styles.streamRange}`}>No date range for this kind of record.</p>
              )}
            </div>
          </div>
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
  initiallyOpen = false,
  onToggleStream,
  onToggleField,
  onToggleSource,
  onSelectAll,
  onSelectNone,
  setRange,
}: {
  active: boolean;
  hidden: boolean;
  onToggleSource: (checked: boolean) => void;
  onToggleStream: (streamName: string) => void;
  onToggleField: (streamId: string, fieldName: string, checked: boolean) => void;
  onSelectAll: (streamId: string) => void;
  onSelectNone: (streamId: string) => void;
  fieldSelection: FieldSelectionState;
  ranges: Record<string, { since: string; until: string }>;
  searching: boolean;
  initiallyOpen?: boolean;
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
  const [isOpen, setIsOpen] = useState(initiallyOpen || source.streams.some((s) => s.selected));

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
          <ConnectorMark connectorId={source.connectorId ?? ""} icon={source.icon ?? null} name={source.name} />
        </span>
        <span className={styles.sourceText}>
          {/* Layout in CSS, not inline: the account handle can only truncate
              if every flex ancestor is allowed to shrink below its content,
              which needs min-width:0 on this label too. */}
          <label
            className={styles.sourceLabel}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === " " || event.key === "Enter") {
                event.stopPropagation();
              }
            }}
          >
            <input
              aria-label={`Share data from ${source.name}`}
              checked={allSelected}
              onChange={(e) => onToggleSource(e.target.checked)}
              ref={(el) => {
                if (el) {
                  el.indeterminate = selected.length > 0 && !allSelected;
                }
              }}
              type="checkbox"
            />
            <span className={`pdpp-body ${styles.sourceName}`}>{source.name}</span>
            {accountLabel && <span className={`pdpp-caption ${styles.sourceAccount}`}>{accountLabel}</span>}
          </label>
        </span>
        <span className={styles.sourceCount}>
          {selected.length > 0 ? `${selected.length} of ${sourceCountPhrase(total)}` : sourceCountPhrase(total)}
        </span>
      </summary>
      <div className={styles.streamList}>
        {source.streams.filter(stream=>isOwnerRecordKind(stream.name,source.connectorId??"")).map((stream) => (
          <StreamRow
            key={stream.name}
            onSelectAll={() => onSelectAll(stream.id)}
            onSelectNone={() => onSelectNone(stream.id)}
            onToggle={() => onToggleStream(stream.name)}
            onToggleField={(fieldName, checked) => onToggleField(stream.id, fieldName, checked)}
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

export function ConsentUnavailable({
  kind,
  onRetry,
}: {
  kind: "expired" | "error" | "answered";
  onRetry?: () => void;
}) {
  const retry = onRetry ?? (() => window.location.reload());
  return (
    <main className={styles.page} data-state={kind}>
      <DataConnectMark />
      <h1 className="pdpp-display">
        {kind === "expired"
          ? "This request has run out."
          : kind === "answered"
            ? "You already answered this request."
            : "This request couldn’t be loaded."}
      </h1>
      {kind === "expired" ? <p>Go back to the app and connect again.</p> : null}
      {kind === "answered" ? <a href="/grants">See your apps</a> : null}
      {kind === "error" && (
        <IcButton onClick={retry} type="button" variant="ghost">
          Try again
        </IcButton>
      )}
    </main>
  );
}

export function ConsentScreen({
  acceptAction,
  demoOnly = false,
  model,
  rejectAction,
  openKinds = false,
  dataConnectHost,
}: {
  /**
   * Records the approval and resolves to the client redirect the browser must
   * follow. Named `*Action` because these cross the client/server boundary as
   * Server Actions — Next.js enforces the suffix on a "use client" component's
   * non-serializable props.
   */
  acceptAction: (decision: ConsentDecision) => Promise<ConsentActionResult>;
  demoOnly?: boolean;
  model: ConsentScreenModel;
  rejectAction: () => Promise<ConsentActionResult>;
  openKinds?: boolean;
  dataConnectHost?: string;
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
  const [noEndDate, setNoEndDate] = useState(
    model.grantExpiry.options.find((option) => option.id === model.grantExpiry.defaultId)?.days === null
  );
  const [activeChipDays, setActiveChipDays] = useState<number | null>(() => {
    const preset = model.grantExpiry.options.find((option) => option.id === model.grantExpiry.defaultId);
    return preset?.days ?? null;
  });
  const [submitState, setSubmitState] = useState<ConsentSubmitState>("idle");
  const [completed, setCompleted] = useState<"accept" | "reject" | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Effects run only after hydration, so this marks the moment the inputs
  // below have live React handlers. A toggle before that point changes only
  // the DOM `checked` flag, and hydration keeps it without an onChange.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const counts = useMemo(() => computeCounts(model.sources, selection), [model.sources, selection]);

  const query = search.trim().toLowerCase();
  const visibleSources = useMemo(() => {
    if (!query) {
      return model.sources;
    }
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
    if (!source) {
      return;
    }
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
    if (!stream) {
      return;
    }
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
    return noEndDate ? "Access lasts until you remove it." : `Access ends ${humanDate(expiry)}.`;
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
    const timeCapableStreamIds = new Set(
      model.sources.flatMap((source) => source.streams.filter((stream) => stream.timePhrase).map((stream) => stream.id))
    );
    const streamFields: Record<string, readonly string[]> = {};
    const streamRanges: Record<string, { since?: string; until?: string }> = {};
    for (const [streamId, range] of Object.entries(ranges)) {
      if (!chosenStreamIds.has(streamId)) {
        continue;
      }
      if (!timeCapableStreamIds.has(streamId)) {
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
    if (demoOnly) {
      return;
    }
    setSubmitState("submitting");
    setSubmitError(null);
    try {
      const result = action === "accept" ? await acceptAction(buildDecision()) : await rejectAction();
      if (!result.ok) {
        setSubmitState("failed");
        setSubmitError(`This request could not be completed. Go back to ${model.client.name} and try again.`);
        return;
      }
      // The OAuth flow ends at the CLIENT's origin, so this is a full document
      // navigation off the console, not a router push. `replace` keeps the
      // consumed challenge out of history — going Back must not re-present a
      // decision the owner has already made.
      setCompleted(action);
      if (result.redirectUrl) {
        window.location.replace(result.redirectUrl);
      }
    } catch {
      setSubmitState("failed");
      setSubmitError(`This request could not be completed. Go back to ${model.client.name} and try again.`);
    }
  }

  const nothingChosen = counts.selectedStreamCount === 0;
  const busy = submitState === "submitting";
  const policyLinks = clientPublishedLinks(model.client.policyLinks);

  if (completed) {
    return <ConsentFinished allowed={completed === "accept"} appName={model.client.name} />;
  }

  return (
    <div className={styles.page} data-hydrated={hydrated ? "true" : "false"}>
      <DataConnectMark host={dataConnectHost} />
      <ConsentHeader client={model.client} />
      {model.purpose.description ? (
        <p className="pdpp-body">It says it will: {plainCopy(model.purpose.description)}</p>
      ) : null}
      {model.retention && !model.retention.includes("did not say how long") ? (
        <p className="pdpp-body">It says it keeps what it reads: {plainCopy(model.retention)}</p>
      ) : null}
      <div className={styles.grid}>
        <div className={styles.body}>
          {model.sources.length > 6 ? (
            <section key="duration">
              <h2 className="pdpp-title">How long</h2>
              <GrantExpiryControls
                activeChipDays={activeChipDays}
                expiry={expiry}
                noEndDate={noEndDate}
                options={model.grantExpiry.options}
                setActiveChipDays={setActiveChipDays}
                setExpiry={setExpiry}
                setNoEndDate={setNoEndDate}
              />
              <p className="pdpp-caption">{endsText()}</p>
            </section>
          ) : null}
          <section aria-labelledby={model.sources.length ? "records-heading" : undefined} className={styles.recordsSection}>
            {model.sources.length ? <><h2 className="pdpp-title" id="records-heading">Choose what it can read</h2><p className={`pdpp-caption ${styles.recordsHint}`}>Anything you leave unticked stays private.</p></> : null}
            {model.sources.length === 0 ? (
              <div className={styles.searchEmpty}>
                <p>You have no data sources yet, so there is nothing to share.</p>
                <a className={buttonVariants()} href="/sources/add">
                  Add a data source
                </a>
              </div>
            ) : (
              <>
                {model.sources.length > 8 ? (
                  <>
                    <div className={styles.searchRow}>
                      <IcInput
                        aria-label="Find a data source"
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setActiveIndex(-1);
                        }}
                        onKeyDown={onSearchKeyDown}
                        placeholder="Find a data source"
                        type="search"
                        value={search}
                      />
                      {search && (
                        <button
                          aria-label="Clear search"
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
                        ? `${visibleSources.length} of ${model.sources.length} data sources match`
                        : `${visibleSources.length} data source${visibleSources.length === 1 ? "" : "s"}`}
                    </div>
                  </>
                ) : null}
                {model.sources.length > 1 ? (
                  <label className={styles.sourceLabel}>
                    <input
                      aria-label="Everything below"
                      checked={counts.selectedStreamCount === counts.totalStreamCount}
                      onChange={(event) =>
                        setSelection(
                          Object.fromEntries(
                            model.sources.map((source) => [
                              source.id,
                              Object.fromEntries(source.streams.map((stream) => [stream.name, event.target.checked])),
                            ])
                          )
                        )
                      }
                      ref={(element) => {
                        if (element) {
                          element.indeterminate =
                            counts.selectedStreamCount > 0 && counts.selectedStreamCount < counts.totalStreamCount;
                        }
                      }}
                      type="checkbox"
                    />
                    Everything below
                  </label>
                ) : null}
                {visibleSources.length === 0 && (
                  <div className={styles.searchEmpty}>
                    No data sources match &ldquo;{search}&rdquo;. Clear the search to see everything.
                  </div>
                )}
                {model.sources.map((source) => {
                  const isHidden = !visibleSources.includes(source);
                  const visibleIndex = visibleSources.indexOf(source);
                  return (
                    <SourceRow
                      active={visibleIndex >= 0 && visibleIndex === activeIndex}
                      fieldSelection={fieldSelection}
                      hidden={isHidden}
                      initiallyOpen={openKinds}
                      key={source.id}
                      onSelectAll={(streamId) => selectFields(streamId, true)}
                      onSelectNone={(streamId) => selectFields(streamId, false)}
                      onToggleField={toggleField}
                      onToggleSource={(checked) => toggleSource(source.id, checked)}
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
          </section>
          {model.sources.length > 0 && model.sources.length <= 6 ? (
            <section key="duration">
              <h2 className="pdpp-title">How long</h2>
              <GrantExpiryControls
                activeChipDays={activeChipDays}
                expiry={expiry}
                noEndDate={noEndDate}
                options={model.grantExpiry.options}
                setActiveChipDays={setActiveChipDays}
                setExpiry={setExpiry}
                setNoEndDate={setNoEndDate}
              />
              <p className="pdpp-caption">{endsText()}</p>
            </section>
          ) : null}
        </div>

        <aside aria-label="Your choice" className={styles.rail}>
          <div className={styles.decisionDock}>
            {model.sources.length > 0 ? (
              <p aria-live="polite" className={styles.decisionSummary}>
                {counts.selectedStreamCount === 0 ? (
                  "Tick at least one data source."
                ) : (
                  <>
                    {model.client.name} will be able to read {counts.selectedSourceCount} data source
                    {counts.selectedSourceCount === 1 ? "" : "s"}{" "}
                    {noEndDate ? "until you remove it" : `until ${humanDate(expiry)}`}.
                  </>
                )}
              </p>
            ) : null}
            {submitError && (
              <p className={styles.submitError} role="alert">
                {submitError}
              </p>
            )}
            <div className={styles.railActions}>
              {model.sources.length > 0 ? (
                <>
                  <IcButton
                    className={styles.decisionButton}
                    disabled={busy || nothingChosen}
                    onClick={() => submit("accept")}
                    type="button"
                    variant="default"
                  >
                    {busy ? "Working…" : "Allow"}
                  </IcButton>
                </>
              ) : null}
              <IcButton
                className={styles.decisionButton}
                disabled={busy}
                onClick={() => submit("reject")}
                type="button"
                variant="ghost"
              >
                Don&apos;t allow
              </IcButton>
            </div>
          </div>
          {model.sources.length ? <p className="pdpp-caption">You can remove this at any time in DataConnect, under Apps.</p> : null}
          {model.client.returnTo ? <p className="pdpp-caption">You’ll go back to {model.client.returnTo}.</p> : null}
          <div className={styles.policyLinks}>
            {policyLinks.length > 0
              ? policyLinks.map((link) => (
                  <a href={link.href} key={link.href} rel="noopener noreferrer nofollow" target="_blank">
                    {model.client.name}'s {plainCopy(link.label).toLowerCase()}
                  </a>
                ))
              : null}
          </div>
        </aside>
      </div>
      <details className={styles.requestDetails}>
        <summary>Technical details</summary>
        <pre className="overflow-x-auto">{JSON.stringify(model, null, 2)}</pre>
      </details>
    </div>
  );
}

// One composed control, not a picker plus a redundant echo: the summary line
// only appears when it says something the picker itself can't — "No end date"
// disables and greys the date input, so that state needs a plain-text
// confirmation the picker alone doesn't give.
function GrantExpiryControls({
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
  return (
    <div className={styles.grantExpiryRow}>
      {options.map((option) => (
        <button
          aria-pressed={option.days === null ? noEndDate : !noEndDate && activeChipDays === option.days}
          className={styles.chip}
          key={option.id}
          onClick={() => {
            setNoEndDate(option.days === null);
            setActiveChipDays(option.days);
            if (option.days !== null) {
              setExpiry(todayPlusDays(option.days));
            }
          }}
          type="button"
        >
          {option.days === null ? "Until I remove it" : option.label}
        </button>
      ))}
    </div>
  );
}

export function ConsentFinished({ appName, allowed }: { appName: string; allowed: boolean }) {
  return (
    <main className={styles.page}>
      <DataConnectMark />
      <h1 className="pdpp-display">
        {allowed ? `Done. ${appName} can now read what you chose.` : `${appName} was not given access.`}
      </h1>
      <p>{allowed ? `You can close this page and go back to ${appName}.` : "You can close this page."}</p>
    </main>
  );
}

function DataConnectMark({ host }: { host?: string }) {
  return (
    <div className={styles.railFooter}>
      <img alt="" height={20} src="/icon" width={20} />
      <span>DataConnect</span>
      {host ? <span className="pdpp-caption">{host}</span> : null}
    </div>
  );
}
