"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useState } from "react";

type RemoveAction = (formData: FormData) => void | Promise<void>;

/**
 * The confirmation step for removing access. Only the submit button sits
 * inside the form; Cancel is a plain button outside it, so it can only close
 * the step and never posts.
 */
export function RemoveAccessConfirmation({
  action,
  fields,
  id,
  onCancel,
  sentence,
  submitLabel,
}: {
  action: RemoveAction;
  fields: readonly (readonly [name: string, value: string])[];
  id: string;
  onCancel: () => void;
  sentence: string;
  submitLabel: string;
}) {
  return (
    <div aria-labelledby={id} aria-modal="true" className="col-span-full rounded-[6px] border border-border-strong p-3" role="alertdialog">
      <p className="text-[13px] text-foreground" id={id}>
        {sentence}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <form action={action}>
          {fields.map(([name, value]) => (
            <input key={`${name}:${value}`} name={name} type="hidden" value={value} />
          ))}
          <input name="confirm_revoke" type="hidden" value="yes" />
          <IcButton size="sm" type="submit" variant="destructive">
            {submitLabel}
          </IcButton>
        </form>
        <IcButton onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </IcButton>
      </div>
    </div>
  );
}

/** "Remove this access" on one access page: a button that opens the confirmation step. */
export function RemoveThisAccess({
  action,
  grantId,
  returnTo,
  sentence,
}: {
  action: RemoveAction;
  grantId: string;
  returnTo: string;
  sentence: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <IcButton className="min-h-11 text-destructive" onClick={() => setConfirming(true)} size="sm" type="button" variant="ghost">
        Remove this access
      </IcButton>
    );
  }
  return (
    <RemoveAccessConfirmation
      action={action}
      fields={[
        ["grant_id", grantId],
        ["return_to", returnTo],
      ]}
      id={`remove-access-${grantId}`}
      onCancel={() => setConfirming(false)}
      sentence={sentence}
      submitLabel="Remove this access"
    />
  );
}

/** Package removal uses the same explicit confirmation and Cancel as app-row removal. */
export function RemovePackageAccess({
  action,
  packageId,
  sentence,
}: {
  action: RemoveAction;
  packageId: string;
  sentence: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <IcButton className="min-h-11 text-destructive" onClick={() => setConfirming(true)} size="sm" type="button" variant="ghost">
        Remove access
      </IcButton>
    );
  }
  return (
    <RemoveAccessConfirmation
      action={action}
      fields={[["package_id", packageId]]}
      id={`remove-package-${packageId}`}
      onCancel={() => setConfirming(false)}
      sentence={sentence}
      submitLabel="Remove access"
    />
  );
}
