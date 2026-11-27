"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  fields,
  idPrefix,
  required,
}: {
  fields: readonly CredentialFieldSpec[];
  idPrefix: string;
  /** Whether the browser should block an empty submit. */
  required: boolean;
}) {
  return (
    <div className="grid gap-3" data-testid="credential-fields">
      {fields.map((field) => (
        <label className="grid gap-1" htmlFor={`${idPrefix}-${field.name}`} key={field.name}>
          <span className="pdpp-eyebrow">{field.label}</span>
          {field.helpText ? (
            <span className="pdpp-caption text-muted-foreground" id={`${idPrefix}-${field.name}-help`}>
              {field.helpText}
            </span>
          ) : null}
          <IcInput
            aria-describedby={field.helpText ? `${idPrefix}-${field.name}-help` : undefined}
            autoComplete={field.autocomplete ?? (field.secret ? "off" : undefined)}
            className="min-h-11"
            defaultValue={field.secret ? undefined : field.defaultValue}
            id={`${idPrefix}-${field.name}`}
            name={field.name}
            placeholder={field.placeholder ?? undefined}
            required={required && field.required}
            type={field.type}
          />
        </label>
      ))}
    </div>
  );
}

/**
 * Sign-in details that are optional: no fields at first. The choice "Save my
 * sign-in so DataConnect can sign in again without me" reveals them.
 */
export function OptionalSignIn({
  checkboxName,
  fields,
  name,
}: {
  checkboxName: string;
  fields: readonly CredentialFieldSpec[];
  name: string;
}) {
  const [saving, setSaving] = useState(false);
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
          <CredentialFields fields={fields} idPrefix="sign-in" required={false} />
          <p className="pdpp-caption text-muted-foreground">{signInCopy.storage(name)}</p>
        </>
      ) : null}
    </div>
  );
}
