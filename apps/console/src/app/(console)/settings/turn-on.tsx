"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { ApprovalDisclosure, ConsentDisclosures, ConsentFacts, PlainDisclosure, readDisclosure, splitFacts, UnknownFactsCount } from "./reachability-consent.tsx";
import { type Action, type Draft, type FactKind, formatDisclosures, effectLines, type Review } from "./prepare-remote-access.ts";
import { plain } from "./plain-text.ts";

// The icon each short fact line carries, as in the approved mockups: who must
// sign in, who can read traffic, and what it costs or how long it lasts.
const factIcons: Record<FactKind, string> = {
  access: "🔒",
  traffic: "👁",
  deal: "⏱",
};

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
  const { lines: routeLines, remaining, unread } = formatDisclosures(candidate);
  const lines = [...routeLines.map((line) => line.text), ...steps.map((step) => step.disclosure.text), ...steps.map((step) => step.label)];
  const bound = [remaining, ...steps.map((step) => step.consent?.disclosures)];
  // An unreadable shape opens Details: the owner is never asked to approve text that is hidden.
  const readable = readDisclosure(bound, candidate.providerId);
  const detailsOpen = readable.unreadable || unread;
  // Everything the service reports that the short lines do not carry, one click away.
  const details = complete ? (
    <details className="grid gap-2" open={detailsOpen}>
      <summary className="cursor-pointer text-sm text-muted-foreground">
        Details · everything {plain(candidate.display.label)} tells us about this connection
      </summary>
      <div className="grid gap-3">
        <p className="pdpp-caption break-words">Connects to: {consent.scope?.query.target}</p>
        {consent.scope?.query.expectedOrigin ? (
          <p className="pdpp-caption break-words">Your address will be: {consent.scope.query.expectedOrigin}</p>
        ) : null}
        <PlainDisclosure value={bound} except={lines} providerId={candidate.providerId} />
        <ConsentDisclosures value={consent.disclosures} providerId={candidate.providerId} />
        <ConsentFacts facts={shown} providerId={candidate.providerId} />
        <UnknownFactsCount count={unknown} service={candidate.display.label} />
        {steps.map((step) => (
          <div className="grid gap-2" key={step.id}>
            <h4 className="pdpp-label">{plain(step.label)}</h4>
            {step.instructions ? <p className="pdpp-caption break-words">{step.instructions}</p> : null}
            <ConsentDisclosures value={step.consent?.disclosures} providerId={candidate.providerId} />
            <ConsentFacts facts={splitFacts(step.consent?.facts ?? []).shown} providerId={candidate.providerId} />
          </div>
        ))}
      </div>
    </details>
  ) : null;
  return (
    <section aria-label="Turn on" className="grid gap-4">
      {changed ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm" role="status">
          Details of this connection changed: {changed.length > 0 ? changed.map((label) => plain(label)).join(", ") : "see Details"}.
        </p>
      ) : null}
      {complete ? (
        <ul className="grid gap-2">
          {routeLines.map((line) => (
            <li className="flex items-start gap-2.5 text-sm" key={line.text}>
              <span aria-hidden="true" className="w-4 flex-none text-center text-muted-foreground">
                {factIcons[line.kind]}
              </span>
              <span>{line.text}</span>
            </li>
          ))}
          {steps.map((step) => (
            <li className="grid gap-1" key={step.id}>
              <span className="text-sm font-medium">{plain(step.label)}</span>
              <span className="text-sm text-muted-foreground">{step.disclosure.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm" role="status">
          We couldn't load this service's details. Try again.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy || !complete} onClick={() => onTurnOn(review)} type="button">
          Turn on remote access
        </Button>
      </div>
      {details}
    </section>
  );
}

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
    <section aria-label="Allow this step" className="grid gap-3 rounded-xl border p-4">
      <h3 className="pdpp-label">{plain(action.label)}</h3>
      <ul className="grid gap-1">
        {effectLines(action).map((line) => (
          <li className="text-sm" key={line}>
            {plain(line)}
          </li>
        ))}
      </ul>
      {action.consent && complete ? <ApprovalDisclosure actionDisclosure={action.disclosure} consent={action.consent} shown={[action.label, ...effectLines(action)]} /> : null}
      {field ? (
        <label className="grid gap-2">
          <span className="text-sm">{plain(field.label)}</span>
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
      {complete ? null : (
        <p className="text-sm" role="status">
          We couldn't load this service's details. Try again.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={busy || !complete || (field !== undefined && value === "")}
          onClick={() => {
            onAllow(action, field ? { [field.secret ? "secret" : "value"]: value } : {});
            setValue("");
          }}
          type="button"
        >
          Allow
        </Button>
        <Button disabled={busy} onClick={onOther} type="button" variant="outline">
          Choose another way
        </Button>
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
    <section aria-label="Turning on" className="grid gap-3 rounded-xl border p-4">
      <p className="flex items-center gap-2 text-sm font-medium" role="status">
        <span aria-hidden="true" className="size-2.5 flex-none animate-pulse rounded-full bg-blue-500" />
        Turning on · This usually takes a few seconds.
      </p>
      <ol className="grid gap-2.5">
        {steps.map((label, index) => {
          const text = index === 1 ? `${label} ${plain(service)}…` : label;
          const mark = index < step ? "✓" : index === step ? "◌" : "○";
          return (
            <li aria-current={index === step ? "step" : undefined} className="flex items-center gap-2.5 text-sm" key={label}>
              <span
                aria-hidden="true"
                className={`flex size-5 flex-none items-center justify-center rounded-full text-xs ${
                  index < step ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : index === step ? "text-blue-500" : "text-muted-foreground"
                }`}
              >
                {mark}
              </span>
              {text}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-3">
        <Button disabled={busy} onClick={onCancel} type="button" variant="outline">
          Cancel
        </Button>
      </div>
    </section>
  );
}
