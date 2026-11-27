"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { fieldLabelWords, splitHelpText } from "./credential-help.ts";
import { IcInput } from "@pdpp/brand-react";
import { useState } from "react";
import { signInCopy } from "./connect-copy.ts";

/** One field the service names, as the server describes it. */
export interface CredentialFieldSpec {
  readonly autocomplete: string | null;
  readonly defaultValue?: string;
  /** What to type, in the manifest's own words; shown under the label. */
  readonly helpText?: string | null;
  readonly label: string;
  readonly name: string;
  readonly placeholder: string | null;
  readonly required: boolean;
  readonly secret: boolean;
  readonly type: "email" | "password" | "text";
}

/** The fields the service names, each with its own label and nothing else. */
export function CredentialFields({
  errorId,
  fields,
  idPrefix,
  required,
}: {
  /** Set when the form was rejected: the id of the alert that says why. */
  errorId?: string | undefined;
  fields: readonly CredentialFieldSpec[];
  idPrefix: string;
  /** Whether the browser should block an empty submit. */
  required: boolean;
}) {
  return (
    <div className="grid gap-3" data-testid="credential-fields">
      {fields.map((field) => {
        const help = field.helpText ? splitHelpText(field.helpText) : null;
        return (
          <div className="grid gap-1" key={field.name}>
            <label className="grid gap-1" htmlFor={`${idPrefix}-${field.name}`}>
              <span className="pdpp-eyebrow">{fieldLabelWords(field.label, field.name)}</span>
              {help ? (
                <span className="pdpp-caption text-muted-foreground" id={`${idPrefix}-${field.name}-help`}>
                  {help.short}
                </span>
              ) : null}
            </label>
            <IcInput
              aria-describedby={[help ? `${idPrefix}-${field.name}-help` : null, errorId ?? null].filter(Boolean).join(" ") || undefined}
              aria-invalid={errorId ? true : undefined}
              autoComplete={field.autocomplete ?? (field.secret ? "off" : undefined)}
              className="min-h-11"
              defaultValue={field.secret ? undefined : field.defaultValue}
              id={`${idPrefix}-${field.name}`}
              name={field.name}
              placeholder={field.placeholder ?? undefined}
              required={required && field.required}
              type={field.type}
            />
            {help?.more ? (
              <details className="pdpp-caption text-muted-foreground">
                <summary className="inline-flex min-h-11 cursor-pointer items-center underline decoration-dotted underline-offset-4">Where to find it</summary>
                <p className="mt-1 break-words">{help.more}</p>
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Sign-in details that are optional: no fields at first. The choice "Save my
 * sign-in so DataConnect can sign in again without me" reveals them.
 */
export function OptionalSignIn({
  checkboxName,
  errorId,
  fields,
  initiallySaving = false,
  name,
}: {
  checkboxName: string;
  /** Set when the form was rejected: the id of the alert that says why. */
  errorId?: string | undefined;
  fields: readonly CredentialFieldSpec[];
  initiallySaving?: boolean;
  name: string;
}) {
  const [saving, setSaving] = useState(initiallySaving);
  return (
    <div className="grid gap-3" data-testid="optional-sign-in">
      <label className="flex min-h-11 items-center gap-2" htmlFor="save-sign-in">
        <input
          checked={saving}
          className="size-4 rounded border-border accent-primary"
          id="save-sign-in"
          name={checkboxName}
          onChange={(event) => setSaving(event.currentTarget.checked)}
          type="checkbox"
          value="1"
        />
        <span className="pdpp-caption text-foreground">{signInCopy.saveSignIn}</span>
      </label>
      {saving ? (
        <>
          <CredentialFields errorId={errorId} fields={fields} idPrefix="sign-in" required={false} />
          <p className="pdpp-caption text-muted-foreground">{signInCopy.storage(name)}</p>
        </>
      ) : null}
    </div>
  );
}
