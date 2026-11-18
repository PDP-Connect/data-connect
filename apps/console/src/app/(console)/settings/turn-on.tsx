"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { Input } from "@/components/ui/input.tsx";
import { ApprovalDisclosure, ConsentDisclosures, ConsentFacts, PlainDisclosure, readDisclosure, splitFacts, UnknownFactsCount } from "./reachability-consent.tsx";
import { type Action, type Draft, disclosureLines, effectLines, type Review } from "./prepare-remote-access.ts";
import { plain } from "./plain-text.ts";

/**
 * The review's disclosure lines, a Details list, and the one button. The click
 * sends the review id and digest of the facts rendered here, read from this
 * same `review` value, so what the owner sees and what is approved cannot differ.
 */
export function TurnOnCard({
  review,
  busy,
  changed,
  onTurnOn,
  steps = [],
}: {
  review: Review;
  /** Owner steps the route approval satisfies (the trial's consent). Their facts are shown here, beside the review's. */
  steps?: Action[];
  busy: boolean;
  /** Labels of the facts that changed since the owner last saw them. */
  changed: string[] | null;
  onTurnOn: (review: Review) => void;
}) {
  const candidate = review.candidate;
  const consent = candidate.consent;
  const complete =
    consent?.scope?.kind === "route" &&
    consent.facts !== undefined &&
    consent.disclosures != null &&
    candidate.consentFactsDigest === consent.consentFactsDigest &&
    steps.every((step) => step.consent?.facts !== undefined && step.consent.disclosures != null);
  const { shown, unknown } = splitFacts(consent?.facts ?? []);
  // disclosureLines words the route's traffic, cost and address; every other string the approval binds shows here too.
  const { traffic: _traffic, cost: _cost, address: _address, ...otherDisclosures } = isRecord(consent?.disclosures) ? consent.disclosures : {};
  const lines = [...disclosureLines(candidate), ...steps.map((step) => step.disclosure.text), ...steps.map((step) => step.label)];
  const bound = [otherDisclosures, ...steps.map((step) => step.consent?.disclosures)];
  // An unreadable shape opens Details: the owner is never asked to approve text that is hidden.
  const readable = readDisclosure(bound);
  const detailsOpen = readable.unreadable;
  return (
    <section aria-label="Turn on" className="grid gap-4">
      {changed ? (
        <p role="status">
          Details of this connection changed: {changed.length > 0 ? changed.map((label) => plain(label)).join(", ") : "see Details"}.
        </p>
      ) : null}
      {complete ? (
        <ul className="grid gap-2">
          {disclosureLines(candidate).map((line) => (
            <li key={line}>{line}</li>
          ))}
          {steps.map((step) => (
            <li key={step.id}>{plain(step.disclosure.text)}</li>
          ))}
        </ul>
      ) : (
        <p role="status">We couldn't load this service's details. Try again.</p>
      )}
      {complete ? <PlainDisclosure value={bound} except={lines} /> : null}
      <button disabled={busy || !complete} onClick={() => onTurnOn(review)} type="button">
        Turn on remote access
      </button>
      {complete ? (
        <details open={detailsOpen}>
          <summary>Details</summary>
          <p className="pdpp-caption break-words">Connects to: {consent.scope?.query.target}</p>
          {consent.scope?.query.expectedOrigin ? (
            <p className="pdpp-caption break-words">Your address will be: {consent.scope.query.expectedOrigin}</p>
          ) : null}
          <ConsentDisclosures value={consent.disclosures} />
          <ConsentFacts facts={shown} />
          <UnknownFactsCount count={unknown} service={candidate.display.label} />
          {steps.map((step) => (
            <div className="grid gap-2" key={step.id}>
              <h4 className="pdpp-label">{plain(step.label)}</h4>
              {step.instructions ? <p className="pdpp-caption break-words">{step.instructions}</p> : null}
              <ConsentFacts facts={splitFacts(step.consent?.facts ?? []).shown} />
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A setup action with effects. Nothing runs until Allow. */
export function AllowCard({
  action,
  draft,
  busy,
  onAllow,
  onOther,
}: {
  action: Action;
  draft: Draft;
  busy: boolean;
  onAllow: (action: Action, input: { value?: string; secret?: string }) => void;
  onOther: () => void;
}) {
  const [value, setValue] = useState("");
  const field = draft.configuration.inputRequirements.find((item) => item.actionId === action.id);
  const complete = action.consent?.facts !== undefined && action.consent.disclosures != null;
  return (
    <section aria-label="Allow this step" className="grid gap-3">
      <h3 className="pdpp-label">{plain(action.label)}</h3>
      <ul className="grid gap-1">
        {effectLines(action).map((line) => (
          <li key={line}>{plain(line)}</li>
        ))}
      </ul>
      {action.consent && complete ? <ApprovalDisclosure actionDisclosure={action.disclosure} consent={action.consent} shown={[action.label, ...effectLines(action)]} /> : null}
      {field ? (
        <label className="grid gap-2">
          <span>{plain(field.label)}</span>
          <Input
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
            placeholder={field.secret ? "Paste it here" : "Type it here"}
            type={field.secret ? "password" : "text"}
            value={value}
          />
          {field.help ? <span className="pdpp-caption">{field.help}</span> : null}
        </label>
      ) : null}
      {complete ? null : <p role="status">We couldn't load this service's details. Try again.</p>}
      <div className="flex flex-wrap gap-3">
        <button
          disabled={busy || !complete || (field !== undefined && value === "")}
          onClick={() => {
            onAllow(action, field ? { [field.secret ? "secret" : "value"]: value } : {});
            setValue("");
          }}
          type="button"
        >
          Allow
        </button>
        <button disabled={busy} onClick={onOther} type="button">
          Choose another way
        </button>
      </div>
    </section>
  );
}

const steps = ["Checked this computer", "Connecting to", "Checking it works from the internet"] as const;

/** Where a turn-on is, from the host's lifecycle phase. */
export function checklistStep(phase: string | null): 1 | 2 {
  return phase === "detected" || phase === "checking" || phase === "verified" ? 2 : 1;
}

export function TurningOnChecklist({
  service,
  step,
  busy,
  onCancel,
}: {
  service: string;
  /** Index of the step under way: 1 connecting, 2 checking. */
  step: 1 | 2;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <section aria-label="Turning on" className="grid gap-3">
      <p role="status">Turning on · This usually takes a few seconds.</p>
      <ol className="grid gap-1">
        {steps.map((label, index) => {
          const text = index === 1 ? `${label} ${plain(service)}…` : label;
          const mark = index < step ? "✓" : index === step ? "◌" : "○";
          return (
            <li aria-current={index === step ? "step" : undefined} key={label}>
              {mark} {text}
            </li>
          );
        })}
      </ol>
      <button disabled={busy} onClick={onCancel} type="button">
        Cancel
      </button>
    </section>
  );
}
