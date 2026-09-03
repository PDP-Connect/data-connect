// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

/**
 * Consent design preview — owner-only, mock data, submits nothing.
 *
 * Built from the REAL `@pdpp/brand-react` components (Sheet, HumanSurface,
 * IcButton, ConnectorIcon, Scope, ...) so there is zero drift by
 * construction: this renders the actual component modules the console's
 * `/sources` and `/explore` pages render, not a transcription of their
 * output. `consent-preview.module.css` supplies ONLY the structural rules
 * those components have no equivalent for (the sticky decision rail, the
 * two-column grid, the mobile bottom-bar collapse) — every value in it is a
 * var(--token) reference into the same tokens these components already use.
 *
 * Preserves the 14 owner feedback items from rounds 1-2 of this task
 * (see /home/tnunamak/code/pdpp/local/CONSENT-OWNER-FEEDBACK-0902.md):
 * arbitrary ISO-8601 grant expiry with quick-fill chips, three trust tiers,
 * keyboard-navigable search, inline field disclosure, sticky decision rail
 * with duration folded in, real platform icons, and two distinct date axes
 * (grant validity vs per-stream data range + apply-to-all).
 */

import { ConnectorIcon, HumanSurface, IcButton, IcInput } from "@pdpp/brand-react";
import { useMemo, useState } from "react";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import styles from "./consent-preview.module.css";
import { CLIENT, dataRangeSummary, fieldSummary, type MockSource, type MockStream, SOURCES } from "./mock-data.ts";

export type TrustTier = "unverified" | "domain" | "verified";
export type PreviewState = "consent" | "signin" | "deny" | "error" | "receipt";

interface ClientLogos {
  readonly client: string | null;
  readonly sources: Record<string, string>;
}

interface SelectionState {
  [sourceId: string]: {
    [streamName: string]: boolean;
  };
}

function initialSelection(): SelectionState {
  const state: SelectionState = {};
  for (const source of SOURCES) {
    const streamState: Record<string, boolean> = {};
    for (const stream of source.streams) {
      streamState[stream.name] = Boolean(stream.selected);
    }
    state[source.id] = streamState;
  }
  return state;
}

function todayPlusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function computeCounts(selection: SelectionState) {
  let selectedStreamCount = 0;
  let totalStreamCount = 0;
  let selectedSourceCount = 0;
  for (const source of SOURCES) {
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

function TrustIdentity({ trust, logos }: { trust: TrustTier; logos: ClientLogos }) {
  const showLogo = trust !== "unverified" && logos.client;
  return (
    <div style={{ alignItems: "flex-start", display: "flex", gap: "1rem" }}>
      {showLogo ? (
        <img
          alt=""
          height={40}
          src={`data:image/svg+xml;utf8,${encodeURIComponent(logos.client as string)}`}
          width={40}
        />
      ) : (
        <span className="pdpp-monogram" data-initials={CLIENT.monogram} />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span className="pdpp-title">{CLIENT.name}</span>
        <span className="pdpp-caption">{CLIENT.domain}</span>
        {trust === "unverified" && (
          <p className="pdpp-caption">
            {CLIENT.name}'s name and logo come from its own registration; nothing about them has been checked.
          </p>
        )}
        {trust === "domain" && (
          <p className="pdpp-caption">
            This app's identity document was fetched from {CLIENT.domain}, so whoever controls that domain is the
            app.
          </p>
        )}
        {trust === "verified" && (
          <p className="pdpp-caption">The operator of this server has confirmed this app.</p>
        )}
        <details className={styles.trustDetails}>
          <summary className="pdpp-caption">What was checked</summary>
          <p className="pdpp-caption">
            {trust === "unverified" &&
              `No check ran. Any app can claim to be named "${CLIENT.name}" and use this logo — treat both as unverified claims until a check below has run.`}
            {trust === "domain" &&
              `This server fetched a client identity document from ${CLIENT.domain} over HTTPS and confirmed it matches this request. That proves domain control, automatically, with no action from ${CLIENT.name} and no human review.`}
            {trust === "verified" &&
              `In addition to the automatic domain check, an operator of this server has explicitly reviewed and registered this app — the strongest tier this server offers.`}
          </p>
        </details>
      </div>
    </div>
  );
}

function StreamRow({
  source,
  stream,
  selected,
  onToggle,
  ranges,
  setRange,
  applyRangeToAllSelected,
}: {
  applyRangeToAllSelected: (since: string, until: string) => void;
  onToggle: () => void;
  ranges: Record<string, { since: string; until: string }>;
  selected: boolean;
  setRange: (sourceId: string, streamName: string, key: "since" | "until", value: string) => void;
  source: MockSource;
  stream: MockStream;
}) {
  const rangeKey = `${source.id}:${stream.name}`;
  const range = ranges[rangeKey] ?? { since: stream.timeSince ?? "", until: stream.timeUntil ?? "" };
  const checkedFields = stream.fieldsSelected ?? stream.fieldsTotal;

  return (
    <div className={styles.streamRow}>
      <input checked={selected} onChange={onToggle} type="checkbox" />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.1875rem", minWidth: 0 }}>
        <span className="pdpp-body">{stream.label}</span>
        <span className="pdpp-caption">{stream.sentence}</span>
        {selected && (
          <details className={styles.narrow}>
            <summary className={styles.narrowSummary}>
              {fieldSummary(stream)} <span className={styles.narrowChange}>Change</span>
            </summary>
            <div className={styles.narrowBody}>
              <div className={styles.fields}>
                {Array.from({ length: stream.fieldsTotal }, (_, index) => {
                  const required = index < 2;
                  const checked = required || index < checkedFields;
                  return (
                    <label className={styles.field} data-required={required} key={index}>
                      <input
                        checked={checked}
                        disabled={required}
                        onChange={() => {
                          /* mock preview: field-level narrowing has no persisted state */
                        }}
                        type="checkbox"
                      />
                      <span>
                        field_{index + 1}
                        {required ? " (required)" : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
              {stream.timePhrase && (
                <div className={styles.streamRange}>
                  <span className="pdpp-caption">{dataRangeSummary(stream) || "All dates"}</span>
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
  logos,
  selection,
  ranges,
  hidden,
  active,
  onToggleStream,
  onToggleSource,
  setRange,
  applyRangeToAllSelected,
}: {
  active: boolean;
  applyRangeToAllSelected: (since: string, until: string) => void;
  hidden: boolean;
  logos: ClientLogos;
  onToggleSource: (checked: boolean) => void;
  onToggleStream: (streamName: string) => void;
  ranges: Record<string, { since: string; until: string }>;
  selection: SelectionState;
  setRange: (sourceId: string, streamName: string, key: "since" | "until", value: string) => void;
  source: MockSource;
}) {
  const selected = source.streams.filter((s) => selection[source.id]?.[s.name]);
  const total = source.streams.length;
  const allSelected = selected.length === total && total > 0;
  const icon = logos.sources[source.id];

  return (
    <div className={styles.sourceRow} data-active={active} data-hidden={hidden} hidden={hidden}>
      <div className={styles.sourceHead}>
        <span className={styles.sourceIcon}>
          <ConnectorIcon icon={icon ? { kind: "inline_svg", svg: icon } : null} name={source.name} />
        </span>
        <div className={styles.sourceText}>
          <label style={{ alignItems: "center", cursor: "pointer", display: "flex", gap: "0.5rem" }}>
            <input
              aria-label={`Share data from ${source.name}`}
              checked={allSelected}
              onChange={(e) => onToggleSource(e.target.checked)}
              ref={(el) => {
                if (el) el.indeterminate = selected.length > 0 && !allSelected;
              }}
              type="checkbox"
            />
            <span className="pdpp-body" style={{ fontWeight: 500 }}>
              {source.name}
            </span>
            <span className="pdpp-caption">{source.account}</span>
          </label>
        </div>
        <span className={styles.sourceCount}>
          {selected.length > 0 ? `${selected.length} of ${total}` : total} data types
        </span>
      </div>
      <div className={styles.streamList}>
        {source.streams.map((stream) => (
          <StreamRow
            applyRangeToAllSelected={applyRangeToAllSelected}
            key={stream.name}
            onToggle={() => onToggleStream(stream.name)}
            ranges={ranges}
            selected={Boolean(selection[source.id]?.[stream.name])}
            setRange={setRange}
            source={source}
            stream={stream}
          />
        ))}
      </div>
    </div>
  );
}

export function ConsentPreviewClient({
  state,
  trust,
  forceMobile,
  logos,
}: {
  forceMobile: boolean;
  logos: ClientLogos;
  state: PreviewState;
  trust: TrustTier;
}) {
  const [selection, setSelection] = useState<SelectionState>(initialSelection);
  const [ranges, setRanges] = useState<Record<string, { since: string; until: string }>>({});
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [expiry, setExpiry] = useState(todayPlusDays(90));
  const [noEndDate, setNoEndDate] = useState(false);
  const [activeChipDays, setActiveChipDays] = useState<number | null>(90);

  const counts = useMemo(() => computeCounts(selection), [selection]);

  const query = search.trim().toLowerCase();
  const visibleSources = useMemo(() => {
    if (!query) return SOURCES;
    return SOURCES.filter((source) => {
      const text = [source.name, source.account, ...source.streams.map((s) => `${s.label} ${s.name}`)]
        .join(" ")
        .toLowerCase();
      return text.includes(query);
    });
  }, [query]);

  function toggleStream(sourceId: string, streamName: string) {
    setSelection((prev) => ({
      ...prev,
      [sourceId]: { ...prev[sourceId], [streamName]: !prev[sourceId]?.[streamName] },
    }));
  }

  function toggleSource(sourceId: string, checked: boolean) {
    const source = SOURCES.find((s) => s.id === sourceId);
    if (!source) return;
    setSelection((prev) => ({
      ...prev,
      [sourceId]: Object.fromEntries(source.streams.map((s) => [s.name, checked])),
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
      for (const source of SOURCES) {
        for (const stream of source.streams) {
          if (selection[source.id]?.[stream.name]) {
            const key = `${source.id}:${stream.name}`;
            next[key] = { since, until };
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
    return noEndDate ? "No end date" : `Access ends ${expiry}`;
  }

  const clientLogos = logos;
  const shellClass = forceMobile ? `${styles.page} ${styles.forceMobile}` : styles.page;

  if (state === "deny") {
    return <TerminalState body={`${CLIENT.name} didn't get any of your data. You can close this tab.`} title="You didn't share anything" tone="neutral" />;
  }
  if (state === "error") {
    return <TerminalState body="Something went wrong on your server. Nothing was shared." title="Nothing was shared" tone="danger" />;
  }
  if (state === "receipt") {
    return (
      <TerminalState
        body={`Ongoing access, ending ${endsText().replace("Access ends ", "")}. ${CLIENT.name} made no retention promise.`}
        title={`${CLIENT.name} can now read what you chose`}
        tone="success"
      />
    );
  }
  if (state === "signin") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: 380 }}>
        <h1 className="pdpp-heading">Sign in</h1>
        <p className="pdpp-body">{CLIENT.name} is asking to read your data. Sign in to decide what it can see.</p>
        <IcButton disabled type="button" variant="human">
          Sign in
        </IcButton>
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <div className={styles.banner}>
        Design preview — mock data, nothing here is submitted, built from the real console component system.
      </div>
      <TrustIdentity logos={clientLogos} trust={trust} />
      <div>
        <h1 className="pdpp-display" style={{ fontSize: "1.75rem" }}>
          {CLIENT.name} wants to read your data
        </h1>
        <p className="pdpp-body" style={{ color: "var(--muted-foreground)" }}>
          Choose what it can read. Anything you leave unchecked stays private.
        </p>
      </div>
      <div className={styles.grid}>
        <div className={styles.body}>
          <HumanSurface style={{ padding: "1.25rem" }}>
            <h2 className="pdpp-title">Terms</h2>
            <p className="pdpp-body">
              Purpose: set by this server because {CLIENT.name} didn't give one — use the data you select as context
              for your AI assistant.
            </p>
            <p className="pdpp-body">Retention: {CLIENT.name} did not say how long it keeps the data it receives.</p>
          </HumanSurface>

          <div className={styles.mobileExpiry}>
            <GrantExpiryControls
              activeChipDays={activeChipDays}
              expiry={expiry}
              noEndDate={noEndDate}
              setActiveChipDays={setActiveChipDays}
              setExpiry={setExpiry}
              setNoEndDate={setNoEndDate}
            />
          </div>

          <div>
            <div style={{ alignItems: "baseline", display: "flex", justifyContent: "space-between" }}>
              <h2 className="pdpp-title">What {CLIENT.name} can read</h2>
              <span className="pdpp-caption">
                {counts.selectedSourceCount} sources · {counts.selectedStreamCount} of {counts.totalStreamCount}{" "}
                streams
              </span>
            </div>
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
                ? `${visibleSources.length} of ${SOURCES.length} sources match`
                : `${visibleSources.length} sources`}
            </div>
            {visibleSources.length === 0 && (
              <div className={styles.searchEmpty}>
                No sources match &ldquo;{search}&rdquo;. Clear the search to see everything.
              </div>
            )}
            {SOURCES.map((source) => {
              const isHidden = !visibleSources.includes(source);
              const visibleIndex = visibleSources.indexOf(source);
              return (
                <SourceRow
                  active={visibleIndex >= 0 && visibleIndex === activeIndex}
                  applyRangeToAllSelected={applyRangeToAllSelected}
                  hidden={isHidden}
                  key={source.id}
                  logos={clientLogos}
                  onToggleSource={(checked) => toggleSource(source.id, checked)}
                  onToggleStream={(streamName) => toggleStream(source.id, streamName)}
                  ranges={ranges}
                  selection={selection}
                  setRange={setRange}
                  source={source}
                />
              );
            })}
          </div>
        </div>

        <aside aria-label="What you're allowing" className={styles.rail}>
          <div className={styles.railSummary}>
            <strong>{counts.selectedSourceCount}</strong> sources · <strong>{counts.selectedStreamCount}</strong> of{" "}
            {counts.totalStreamCount} streams selected
          </div>
          <p className={styles.railMobileSummary}>
            {endsText()} · {counts.selectedStreamCount} streams
          </p>
          <GrantExpiryControls
            activeChipDays={activeChipDays}
            expiry={expiry}
            noEndDate={noEndDate}
            setActiveChipDays={setActiveChipDays}
            setExpiry={setExpiry}
            setNoEndDate={setNoEndDate}
          />
          <p className={styles.railEnds}>{endsText()}</p>
          <div className={styles.railActions}>
            <IcButton type="button" variant="human">
              Allow access
            </IcButton>
            <IcButton type="button" variant="ghost">
              Cancel
            </IcButton>
            <p className="pdpp-caption">You'll return to {CLIENT.domain}</p>
          </div>
        </aside>
      </div>
      <footer style={{ alignItems: "center", display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        <a href="https://pdpp.dev" style={{ alignItems: "center", display: "inline-flex", gap: "0.5rem" }}>
          <PdppLogo size={14} />
          <span className="pdpp-caption">Secured by PDPP</span>
        </a>
      </footer>
    </div>
  );
}

function GrantExpiryControls({
  expiry,
  setExpiry,
  noEndDate,
  setNoEndDate,
  activeChipDays,
  setActiveChipDays,
}: {
  activeChipDays: number | null;
  expiry: string;
  noEndDate: boolean;
  setActiveChipDays: (v: number | null) => void;
  setExpiry: (v: string) => void;
  setNoEndDate: (v: boolean) => void;
}) {
  return (
    <div className={styles.grantExpiry}>
      <span className={styles.grantExpiryLabel}>Access duration — how long {CLIENT.name} can read</span>
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
        <button
          aria-pressed={activeChipDays === 90}
          className={styles.chip}
          onClick={() => {
            setNoEndDate(false);
            setActiveChipDays(90);
            setExpiry(todayPlusDays(90));
          }}
          type="button"
        >
          90 days
        </button>
        <button
          aria-pressed={activeChipDays === 365}
          className={styles.chip}
          onClick={() => {
            setNoEndDate(false);
            setActiveChipDays(365);
            setExpiry(todayPlusDays(365));
          }}
          type="button"
        >
          1 year
        </button>
      </div>
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
    </div>
  );
}

function TerminalState({ title, body, tone }: { body: string; title: string; tone: "success" | "neutral" | "danger" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 480 }}>
      <h1 className="pdpp-heading">{title}</h1>
      <p className="pdpp-body">{body}</p>
      <a href="/design-consent-preview">Back to the preview</a>
    </div>
  );
}
