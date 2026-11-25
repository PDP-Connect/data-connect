// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { IcButton, Text } from "@pdpp/brand-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState, useTransition } from "react";
import { runUpdatesSequentially } from "./updates-ready-action.ts";
import { formatUpdateResult, type UpdatesReadyModel } from "./updates-ready-model.ts";

export function UpdatesReadySlot({
  demoModel,
  initialResult,
  interactive,
  updates,
}: {
  demoModel?: UpdatesReadyModel | null;
  initialResult?: string | null;
  interactive: boolean;
  updates?: Promise<UpdatesReadyModel | null>;
}) {
  if (demoModel) {
    return <UpdatesReady initialResult={initialResult} interactive={interactive} model={demoModel} />;
  }
  if (!updates) return null;
  return <ResolvedUpdates initialResult={initialResult} interactive={interactive} updates={updates} />;
}

function ResolvedUpdates({
  initialResult,
  interactive,
  updates,
}: {
  initialResult?: string | null;
  interactive: boolean;
  updates: Promise<UpdatesReadyModel | null>;
}) {
  const model = use(updates);
  return model ? <UpdatesReady initialResult={initialResult} interactive={interactive} model={model} /> : null;
}

function UpdatesReady({
  initialResult,
  interactive,
  model,
}: {
  initialResult?: string | null;
  interactive: boolean;
  model: UpdatesReadyModel;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ failed: boolean; text: string } | null>(
    initialResult ? { failed: true, text: initialResult } : null
  );

  function updateAll() {
    setResult(null);
    startTransition(async () => {
      const { updateConnectorAction } = await import("./add/connector-install-actions.ts");
      const outcomes = await runUpdatesSequentially(model.kinds, updateConnectorAction);
      setResult({ failed: outcomes.some((outcome) => !outcome.ok), text: formatUpdateResult(outcomes) });
      router.refresh();
    });
  }

  return (
    <aside className="rr-s-updates-ready" data-testid="updates-ready" role="status">
      <Text as="p"><strong>Updates are ready</strong> for {model.namesText}. <Link href={model.seeChangesHref}>See what changes</Link></Text>
      <div className="rr-s-updates-ready__action">
        <IcButton disabled={!interactive || pending} onClick={updateAll} size="sm" type="button">
          {pending ? "Updating…" : model.buttonLabel}
        </IcButton>
        {result ? (
          <span aria-live="polite" className={result.failed ? "text-destructive" : "text-muted-foreground"} role={result.failed ? "alert" : "status"}>
            {result.text}
          </span>
        ) : null}
      </div>
    </aside>
  );
}
