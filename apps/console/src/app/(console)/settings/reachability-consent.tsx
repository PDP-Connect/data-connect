"use client";
import type {
  projectAction,
  projectFact,
  projectRuntimeReview,
} from "pdpp-reference-implementation/reachability-projection";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { isKnownFalseCondition } from "./known-false-conditions.ts";
import { formatLocalTime, humanizeKey, plain, verbatimValue } from "./plain-text.ts";

type Fact = ReturnType<typeof projectFact>;
type Action = ReturnType<typeof projectAction>;

/**
 * Facts the owner can read: known ones, including those known to be empty
 * (shown as None). `unknown` counts only the facts the service does not publish.
 */
export function splitFacts(facts: Fact[]): { shown: Fact[]; unknown: number } {
  return { shown: facts.filter((fact) => fact.known), unknown: facts.filter((fact) => !fact.known).length };
}

export function UnknownFactsCount({ count, service }: { count: number; service: string }) {
  if (count === 0) return null;
  return (
    <p className="pdpp-caption">
      {count} {count === 1 ? "fact" : "facts"} {plain(service)} doesn't publish.
    </p>
  );
}

// Every known fact is shown: the owner approves exactly what is listed here.
export function ConsentFacts({ facts: all, providerId }: { facts: Fact[]; providerId: string | null | undefined }) {
  const facts = all.filter((fact) => !isKnownFalseCondition(providerId, fact.value));
  const groups = [...new Set(facts.map((fact) => fact.group))];
  return (
    <div className="grid gap-4">
      {groups.map((group) => (
        <section aria-label={plain(group)} key={group}>
          <h4 className="pdpp-label">{plain(group)}</h4>
          <dl className="grid gap-3">
            {facts
              .filter((fact) => fact.group === group)
              .map((fact) => (
                <div key={fact.id}>
                  <dt className="pdpp-label">{plain(fact.label)}</dt>
                  <dd className="pdpp-caption whitespace-pre-wrap break-words">
                    {fact.known ? (fact.value === null ? "None" : String(fact.value)) : (fact.reason ? `Unknown: ${plain(fact.reason)}` : "Unknown")}
                  </dd>
                  <dd className="pdpp-caption text-muted-foreground">
                    {plain(fact.source)}
                    {fact.asOf ? ` · ${formatLocalTime(fact.asOf)}` : " · Date not recorded"}
                  </dd>
                </div>
              ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

// Disclosures are library-owned typed data. Keep every item visible without
// flattening objects, truncating long strings or interpreting provider prose.
export function ConsentDisclosures({ value, providerId }: { value: unknown; providerId?: string | null }) {
  if (isKnownFalseCondition(providerId, value)) return null;
  if (value === null) {
    return <span>None</span>;
  }
  if (Array.isArray(value)) {
    return (
      <ol className="grid gap-3">
        {value.filter((item) => !isKnownFalseCondition(providerId, item)).map((item, index) => (
          <li key={index}>
            <ConsentDisclosures value={item} providerId={providerId} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="grid gap-3">
        {Object.entries(value).filter(([, item]) => !isKnownFalseCondition(providerId, item)).map(([key, item]) => (
          <div key={key}>
            <dt className="pdpp-label">{humanizeKey(key)}</dt>
            <dd>
              <ConsentDisclosures value={item} providerId={providerId} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  // Values are approval evidence, not labels (an ISO time shows as a local time); React still escapes this text.
  return <span data-consent-value="" className="pdpp-caption whitespace-pre-wrap break-words">{verbatimValue(String(value))}</span>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Fields that are identifiers, evidence or addresses, never text for the owner to read.
const machineKey =
  /^(?:id|kind|type|digest|revision|hash|href|url|uri|links?|actor|verification|purpose|permission|scope)$|(?:Id|Ids|Digest|Revision|Hash|Href|Url|Uri|At|Time|Timestamp)$|[_-](?:id|digest|revision|hash|href|url|uri|at|time|timestamp)$/;
// Keys whose single-word value is still a sentence ("Free").
const textKey = /^(?:text|summary|description|message|title|note|reason|condition|conditions|disclosure|disclosures|warning|detail|details|statement)$/i;
// Enum-like words, ids and digests, URLs and timestamps: machine values by shape.
const machineShape = /^(?:[a-z][a-z0-9_.:-]*|[0-9a-f]{16,}|[a-z][a-z0-9+.-]*:\/\/\S*|\d{4}-\d{2}-\d{2}T\S*)$/;

/**
 * Walks a disclosure for the text an owner reads. A string with spaces, or a one-word string under a
 * text key, is a sentence; ids, digests, revisions, links, enum words and timestamps are not. A number,
 * a boolean or a capitalised one-word string under another key has no known reading: `unreadable`.
 */
export function readDisclosure(value: unknown): { sentences: string[]; unreadable: boolean } {
  const found: string[] = [];
  let unreadable = false;
  const walk = (node: unknown, key: string) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
    } else if (isRecord(node)) {
      for (const [name, item] of Object.entries(node)) walk(item, name);
    } else if (machineKey.test(key)) {
      return;
    } else if (typeof node === "string") {
      const text = node.trim();
      if (text === "") return;
      if (/\s/.test(text) || textKey.test(key)) found.push(text);
      else if (!machineShape.test(text)) unreadable = true;
    } else {
      unreadable = true;
    }
  };
  walk(value, "");
  return { sentences: found, unreadable };
}

const asSentence = (text: string) => {
  const sentence = plain(text).trim();
  const cased = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
  return /[.!?]$/.test(cased) ? cased : `${cased}.`;
};

/**
 * The sentences a disclosure holds, in reading order, found by walking it (see readDisclosure), so the
 * text is shown wherever the host puts it. Sentences in `except` are already on screen and are left out.
 */
export function disclosureSentences(value: unknown, except: readonly string[] = []): string[] {
  const seen = new Set(except.filter((line) => line.trim() !== "").map(asSentence));
  const sentences: string[] = [];
  for (const text of readDisclosure(value).sentences) {
    if (plain(text).trim() === "") continue;
    const sentence = asSentence(text);
    if (!seen.has(sentence)) {
      seen.add(sentence);
      sentences.push(sentence);
    }
  }
  return sentences;
}

/** The structured disclosure, verbatim, for the owner who wants every field. Closed unless `open`. */
export function DisclosureDetails({ value, providerId, open }: { value: unknown; providerId?: string | null; open?: boolean }) {
  return (
    <details open={open}>
      <summary>Details</summary>
      <ConsentDisclosures value={value} providerId={providerId} />
    </details>
  );
}

export function PlainDisclosure({ value, except }: { value: unknown; except?: readonly string[] }) {
  const sentences = disclosureSentences(value, except);
  if (sentences.length === 0) return null;
  return (
    <ul className="grid gap-2">
      {sentences.map((sentence) => (
        <li key={sentence}>{sentence}</li>
      ))}
    </ul>
  );
}

type ApprovalConsent = NonNullable<Action["consent"]>;

/**
 * What an approval card shows before its approve or save control: every sentence the disclosure and the
 * action's own disclosure hold, the facts, and the structured Details. The text is found by walking, so
 * no field is named here. `shown` lists text the card already prints. An unreadable shape opens Details
 * (fail closed: the owner is never asked to approve text that is hidden).
 */
export function ApprovalDisclosure({
  consent,
  actionDisclosure,
  shown = [],
}: {
  consent: ApprovalConsent;
  actionDisclosure?: unknown;
  shown?: readonly string[];
}) {
  const bound = { disclosure: actionDisclosure, disclosures: consent.disclosures };
  const readable = readDisclosure(bound);
  const open = readable.unreadable || readable.sentences.length === 0;
  return (
    <>
      <PlainDisclosure value={bound} except={shown} />
      {consent.facts ? <ConsentFacts facts={consent.facts} providerId={consent.scope.providerId} /> : null}
      <DisclosureDetails open={open} value={consent.disclosures} providerId={consent.scope.providerId} />
    </>
  );
}

export function SetupApprovalCard({
  action,
  busy,
  onApprove,
  children,
  buttonLabel = "Approve setup action",
}: {
  action: Action;
  busy?: boolean;
  onApprove: (approval: {
    kind: "setup";
    digest: string;
    disclosureRevision: string;
    consentFactsDigest: string;
  }) => void;
  children?: React.ReactNode;
  buttonLabel?: string;
}) {
  const [approvedDigest, setApprovedDigest] = useState<string | null>(null);
  const consent = action.consent;
  const complete =
    consent?.facts !== undefined &&
    consent.disclosures != null &&
    consent.scope.kind === "setup" &&
    consent.scope.actionId === action.id &&
    consent.scope.actionDigest === action.digest &&
    consent.scope.disclosureRevision === action.disclosure.revision;
  const checked = approvedDigest === consent?.consentFactsDigest;
  return (
    <section aria-label="Setup approval" className="grid gap-4 rounded-lg border p-4">
      <h3 className="pdpp-label">{plain(action.label)}</h3>
      {children}
      {complete ? (
        <>
          <ApprovalDisclosure actionDisclosure={action.disclosure} consent={consent} shown={[action.label]} />
          <label className="pdpp-caption flex items-start gap-2">
            <input
              checked={checked}
              onChange={(event) => setApprovedDigest(event.target.checked ? consent.consentFactsDigest : null)}
              type="checkbox"
            />
            I approve this setup action and its disclosures.
          </label>
        </>
      ) : (
        <p className="pdpp-caption" role="status">
          We couldn't load this service's details. Try again.
        </p>
      )}
      <button
        disabled={busy || !complete || !checked}
        onClick={() => {
          if (complete && checked) {
            onApprove({
              kind: "setup",
              digest: action.digest,
              disclosureRevision: action.disclosure.revision,
              consentFactsDigest: consent.consentFactsDigest,
            });
          }
        }}
        type="button"
      >
        {buttonLabel}
      </button>
    </section>
  );
}

export function RuntimeRouteConsentCard({
  review,
  busy,
  onApprove,
}: {
  review: ReturnType<typeof projectRuntimeReview>;
  busy?: boolean;
  onApprove: (approval: { kind: "route"; consentFactsDigest: string }) => void;
}) {
  const [approvedDigest, setApprovedDigest] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const valid =
    review.scope?.kind === "route" &&
    review.facts !== undefined &&
    review.disclosures !== undefined &&
    review.disclosures !== null &&
    Date.parse(review.expiresAt) > now;
  return (
    <section aria-label="Changed details approval" className="grid gap-4 rounded-lg border p-4">
      <h3 className="pdpp-label">Details of this connection changed</h3>
      {valid ? (
        <>
          <p className="pdpp-caption break-words">Connects to: {review.scope?.query.target}</p>
          {review.scope?.query.expectedOrigin ? (
            <p className="pdpp-caption break-words">Your address will be: {review.scope.query.expectedOrigin}</p>
          ) : null}
          <ConsentDisclosures value={review.disclosures} providerId={review.scope?.providerId} />
          <ConsentFacts facts={review.facts} providerId={review.scope?.providerId} />
          <label>
            <input
              checked={approvedDigest === review.consentFactsDigest}
              onChange={(event) => setApprovedDigest(event.target.checked ? review.consentFactsDigest : null)}
              type="checkbox"
            />{" "}
            I approve the changed details.
          </label>
        </>
      ) : (
        <p>These details have expired. Reload to see the new ones.</p>
      )}
      <button
        type="button"
        disabled={busy || !valid || approvedDigest !== review.consentFactsDigest}
        onClick={() =>
          valid &&
          approvedDigest === review.consentFactsDigest &&
          onApprove({ kind: "route", consentFactsDigest: review.consentFactsDigest })
        }
      >
        Turn on again
      </button>
    </section>
  );
}
