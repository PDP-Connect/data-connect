"use client";
import type {
  projectAction,
  projectCandidate,
  projectFact,
  projectRuntimeReview,
} from "pdpp-reference-implementation/reachability-projection";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

type Fact = ReturnType<typeof projectFact>;
type Action = ReturnType<typeof projectAction>;

export function ConsentFacts({ facts }: { facts: Fact[] }) {
  const groups = [...new Set(facts.map((fact) => fact.group))];
  return (
    <div className="grid gap-4">
      {groups.map((group) => (
        <section aria-label={group} key={group}>
          <h4 className="pdpp-label">{group}</h4>
          <dl className="grid gap-3">
            {facts
              .filter((fact) => fact.group === group)
              .map((fact) => (
                <div key={fact.id}>
                  <dt className="pdpp-label">{fact.label}</dt>
                  <dd className="pdpp-caption whitespace-pre-wrap break-words">
                    {fact.known ? (fact.value === null ? "None" : String(fact.value)) : `Unknown: ${fact.reason}`}
                  </dd>
                  <dd className="pdpp-caption text-muted-foreground">
                    {fact.source}
                    {fact.asOf ? ` · ${fact.asOf}` : " · Evidence date not recorded"}
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
export function ConsentDisclosures({ value }: { value: unknown }) {
  if (value === null) {
    return <span>None</span>;
  }
  if (Array.isArray(value)) {
    return (
      <ol className="grid gap-3">
        {value.map((item, index) => (
          <li key={index}>
            <ConsentDisclosures value={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="grid gap-3">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt className="pdpp-label">{key}</dt>
            <dd>
              <ConsentDisclosures value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="pdpp-caption whitespace-pre-wrap break-words">{String(value)}</span>;
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
      <h3 className="pdpp-label">{action.label}</h3>
      {children}
      {complete ? (
        <>
          <ConsentDisclosures value={consent.disclosures} />
          <ConsentFacts facts={consent.facts!} />
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
          Consent details unavailable from provider library.
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

export function RouteConsentCard({
  review,
  busy,
  onApprove,
}: {
  review: ReturnType<typeof projectCandidate>;
  busy?: boolean;
  onApprove: (approval: { kind: "route"; consentFactsDigest: string }) => void;
}) {
  const [approvedDigest, setApprovedDigest] = useState<string | null>(null);
  const consent = review.consent;
  const complete =
    consent?.scope?.kind === "route" &&
    consent.facts !== undefined &&
    consent.disclosures != null &&
    review.consentFactsDigest === consent.consentFactsDigest;
  const checked = approvedDigest === consent?.consentFactsDigest;
  return (
    <section aria-label="Route consent" className="grid gap-4 rounded-lg border p-4">
      <h3 className="pdpp-label">Review reachability</h3>
      {complete ? (
        <>
          <p className="pdpp-caption break-words">Requested target: {consent.scope?.query.target}</p>
          <ConsentDisclosures value={consent.disclosures} />
          <ConsentFacts facts={consent.facts} />
          <label className="pdpp-caption flex items-start gap-2">
            <input
              checked={checked}
              onChange={(event) => setApprovedDigest(event.target.checked ? consent.consentFactsDigest : null)}
              type="checkbox"
            />
            I approve this route and every disclosure shown above.
          </label>
        </>
      ) : (
        <p className="pdpp-caption" role="status">
          Consent details unavailable from provider library.
        </p>
      )}
      <button
        disabled={busy || !complete || !checked}
        onClick={() =>
          complete && checked && onApprove({ kind: "route", consentFactsDigest: consent.consentFactsDigest })
        }
        type="button"
      >
        Apply reachability
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
    <section aria-label="Runtime route consent" className="grid gap-4 rounded-lg border p-4">
      <h3 className="pdpp-label">Review changed reachability</h3>
      {valid ? (
        <>
          <ConsentDisclosures value={review.disclosures} />
          <ConsentFacts facts={review.facts} />
          <label>
            <input
              checked={approvedDigest === review.consentFactsDigest}
              onChange={(event) => setApprovedDigest(event.target.checked ? review.consentFactsDigest : null)}
              type="checkbox"
            />{" "}
            I approve the current route disclosures.
          </label>
        </>
      ) : (
        <p>Fresh consent details are required.</p>
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
        Approve current route
      </button>
    </section>
  );
}
