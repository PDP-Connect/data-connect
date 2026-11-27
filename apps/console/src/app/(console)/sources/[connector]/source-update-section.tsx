"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { use, useState, useTransition } from "react";
import { updateConnectorAction } from "../add/connector-install-actions.ts";
import { ACTION_ERROR_COPY } from "./source-detail-copy.ts";

export interface SourceUpdateModel {
  connectorKey: string;
  currentVersion: string;
  otherSources: string[];
  targetVersion: string;
}

export function SourceUpdateSlot({
  demoModel,
  displayName,
  updates,
  version,
}: {
  demoModel: SourceUpdateModel | null;
  displayName: string;
  updates?: Promise<SourceUpdateModel | null>;
  version: string | null;
}) {
  if (demoModel) {
    return <SourceUpdateSection displayName={displayName} model={demoModel} />;
  }
  if (!updates) return null;
  return <ResolvedSourceUpdate displayName={displayName} updates={updates} version={version} />;
}

function ResolvedSourceUpdate({
  displayName,
  updates,
  version,
}: {
  displayName: string;
  updates: Promise<SourceUpdateModel | null>;
  version: string | null;
}) {
  return <SourceUpdateSlotResolved displayName={displayName} model={use(updates)} version={version} />;
}

function SourceUpdateSlotResolved({
  displayName,
  model,
}: {
  displayName: string;
  model: SourceUpdateModel | null;
  version: string | null;
}) {
  return model ? <SourceUpdateSection displayName={displayName} model={model} /> : null;
}

function SourceUpdateSection({ displayName, model }: { displayName: string; model: SourceUpdateModel }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);
  return (
    <div className="mb-6">
      <p className="pdpp-body text-muted-foreground">
        An update for {displayName} is ready.
      </p>
      {model.otherSources.length > 0 ? (
        <p className="pdpp-body mt-1 text-muted-foreground">It also updates {formatNames(model.otherSources)}.</p>
      ) : null}
      <div className="mt-3 flex flex-col items-start gap-2">
        <IcButton
          aria-label={`Update ${displayName}`}
          disabled={pending}
          onClick={() => {
            setError(null);
            setUpdated(false);
            startTransition(async () => {
              const result = await updateConnectorAction(model.connectorKey);
              if (!result.ok) {
                setError(result.message);
                return;
              }
              setUpdated(true);
              router.refresh();
            });
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          {pending ? "Updating…" : "Update"}
        </IcButton>
        {updated ? <span className="pdpp-body text-muted-foreground">Updated. Refreshing…</span> : null}
        {error ? (
          <div className="text-sm text-destructive" role="alert">
            <p>{ACTION_ERROR_COPY}</p>
            <details className="mt-1 text-muted-foreground">
              <summary className="cursor-pointer">What went wrong</summary>
              <code className="mt-1 block break-words font-mono text-xs">{error}</code>
            </details>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatNames(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}
