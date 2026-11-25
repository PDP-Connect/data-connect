"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcInput } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { type SyntheticEvent, useState, useTransition } from "react";
import { type RunInteractionActionState, submitRunInteractionAction } from "./actions.ts";

interface InteractionField {
  autocomplete?: string | null;
  format: "email" | "password" | "text";
  label: string | null;
  name: string;
  required: boolean;
}

interface Props {
  fields: InteractionField[];
  interactionId: string;
  kind: "credentials" | "otp" | "manual_action" | string;
  message: string;
  runId: string;
  submitLabel?: string | null;
}

const INITIAL: RunInteractionActionState = { error: null, status: null };

export function RunInteractionForm({ runId, interactionId, kind, message, fields, submitLabel }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<RunInteractionActionState>(INITIAL);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  function submitWithStatus(formData: FormData, status: "success" | "cancelled") {
    formData.set("status", status);
    formData.set("run_id", runId);
    formData.set("interaction_id", interactionId);
    startTransition(async () => {
      const next = await submitRunInteractionAction(INITIAL, formData);
      setState(next);
      if (!next.error) {
        router.refresh();
      }
    });
  }

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    submitWithStatus(formData, "success");
  }

  function handleCancel() {
    setConfirmingCancel(true);
  }

  function confirmCancel() {
    submitWithStatus(new FormData(), "cancelled");
    setConfirmingCancel(false);
  }

  const effectiveFields =
    kind === "otp" && fields.length === 0
      ? [
          {
            format: "text" as const,
            label: "Code",
            name: "code",
            required: true,
          },
        ]
      : fields;
  const showFields = kind !== "manual_action" && effectiveFields.length > 0;
  const effectiveSubmitLabel = submitLabel ?? getSubmitLabel(kind);

  return (
    <form
      aria-label="Answer this request"
      autoComplete="off"
      className="mt-3 flex flex-col gap-3"
      onSubmit={handleSubmit}
    >
      <p className="pdpp-caption text-muted-foreground">{message}</p>
      {showFields ? (
        <div className="grid gap-2">
          {effectiveFields.map((field) => {
            const fieldId = `interaction-${interactionId}-${field.name}`;
            return (
              <label className="flex flex-col gap-1" htmlFor={fieldId} key={field.name}>
                <span className="pdpp-caption text-muted-foreground">
                  {field.label || field.name}
                  {field.required ? <span aria-hidden="true"> *</span> : null}
                </span>
                <IcInput
                  autoComplete={field.autocomplete ?? "off"}
                  id={fieldId}
                  name={field.name}
                  required={field.required}
                  spellCheck={false}
                  type={field.format}
                />
              </label>
            );
          })}
        </div>
      ) : null}
      <p className="pdpp-caption text-muted-foreground">
        Your answer is used only for this sync. DataConnect does not save it with the data source.
      </p>
      {state.error ? (
        <p className="pdpp-caption text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
      {confirmingCancel ? (
        <fieldset className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
          <legend className="pdpp-caption text-foreground">Cancel this request? DataConnect stops waiting for your answer.</legend>
          <div className="flex flex-wrap gap-2">
            <IcButton disabled={isPending} onClick={confirmCancel} size="sm" type="button" variant="destructive">
              Yes, cancel interaction
            </IcButton>
            <IcButton disabled={isPending} onClick={() => setConfirmingCancel(false)} size="sm" type="button" variant="ghost">
              Keep answering
            </IcButton>
          </div>
        </fieldset>
      ) : (
        <div className="flex flex-wrap gap-2">
          <IcButton disabled={isPending} size="sm" type="submit">
            {isPending ? "Submitting…" : effectiveSubmitLabel}
          </IcButton>
          <IcButton disabled={isPending} onClick={handleCancel} size="sm" type="button" variant="ghost">
            Cancel interaction
          </IcButton>
        </div>
      )}
    </form>
  );
}

function getSubmitLabel(kind: Props["kind"]): string {
  if (kind === "manual_action") {
    return "I've completed this step — continue";
  }
  if (kind === "otp") {
    return "Submit code";
  }
  return "Submit credentials";
}
