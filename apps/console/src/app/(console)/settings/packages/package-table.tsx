"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ConnectorMark } from "../../components/connector-mark.tsx";
import { WentWrong } from "../../sources/add/connect-parts.tsx";
import { uninstallConnectorAction, updateConnectorAction } from "../../sources/add/connector-install-actions.ts";
import { type PackageRow, packagesCopy } from "./package-rows-model.ts";

function PackageRowView({ row }: { row: PackageRow }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (act: () => Promise<{ ok: true } | { message: string; ok: false }>) => {
    setError(null);
    startTransition(async () => {
      const result = await act();
      if (result.ok) router.refresh();
      else setError(result.message);
    });
  };
  return (
    <tr className="border-b border-border align-middle" data-testid={`package-row-${row.connectorKey}`}>
      <td className="py-3 pr-4">
        <span className="inline-flex items-center gap-3">
          <ConnectorMark connectorId={row.connectorKey} icon={row.icon} name={row.displayName} />
          {row.displayName}
        </span>
      </td>
      <td className="py-3 pr-4 text-muted-foreground">{row.version ?? ""}</td>
      <td className="py-3">
        <div className="flex flex-wrap items-center gap-2">
          {row.updateTo ? (
            <IcButton
              className="min-h-11 sm:min-h-[30px]"
              disabled={isPending}
              onClick={() => run(() => updateConnectorAction(row.connectorId))}
              size="sm"
              type="button"
              variant="ghost"
            >
              Update
            </IcButton>
          ) : null}
          {row.canUninstall ? (
            <IcButton
              className="min-h-11 sm:min-h-[30px]"
              disabled={isPending}
              onClick={() => {
                if (window.confirm(packagesCopy.uninstallConfirm)) run(() => uninstallConnectorAction(row.connectorKey));
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              Uninstall
            </IcButton>
          ) : null}
        </div>
        {error ? (
          <div className="mt-1 grid gap-1" role="alert">
            <p className="pdpp-caption text-destructive">{packagesCopy.couldNot}</p>
            <WentWrong message={error} />
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export function PackageTable({ rows }: { rows: readonly PackageRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="pdpp-caption text-muted-foreground" data-testid="package-table-empty">
        {packagesCopy.empty}
      </p>
    );
  }
  return (
    <table className="w-full max-w-3xl text-left" data-testid="package-table">
      <thead>
        <tr className="border-b border-border text-muted-foreground">
          <th className="pdpp-caption py-2 pr-4 font-medium" scope="col">Service</th>
          <th className="pdpp-caption py-2 pr-4 font-medium" scope="col">Version</th>
          <th className="pdpp-caption py-2 font-medium" scope="col"><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <PackageRowView key={row.connectorKey} row={row} />
        ))}
      </tbody>
    </table>
  );
}
