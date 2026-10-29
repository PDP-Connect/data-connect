// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import type { ConnectorUpdatePlanItem } from "../../lib/connector-update-contract.ts";

export const REASON_LABELS: Readonly<Record<string, string>> = {
  compatibility_not_declared: "Compatibility is unknown: this connector does not declare it",
  downgrade: "Downgrade: the target is older than the installed version",
  incomparable_version: "Version order cannot be determined",
  major_version: "Major version change",
  prerelease_version: "Prerelease version",
  same_version_republish: "Republished: same version, different package",
  verification_failed: "Verification failed: this target cannot be installed",
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replaceAll("_", " ");
}

export function connectorDisplayName(item: { connector_id: string; display_name?: string }): string {
  return item.display_name?.trim() || item.connector_id;
}

function versionLabel(version: string | null): string {
  return version ? `v${version}` : "unversioned";
}

function FieldList({ label, fields }: { fields: readonly string[]; label: string }) {
  if (!fields.length) {
    return null;
  }
  return (
    <div>
      <dt className="font-medium text-foreground">{label}</dt>
      <dd className="font-mono text-muted-foreground">{fields.join(", ")}</dd>
    </div>
  );
}

export function ReviewItem({
  busy = false,
  item,
  onConfirm,
}: {
  busy?: boolean;
  item: ConnectorUpdatePlanItem;
  onConfirm?: (item: ConnectorUpdatePlanItem) => void;
}) {
  const diff = item.manifest_diff;
  const blocked = item.reasons.includes("verification_failed");
  return (
    <li className="py-3" data-connector-id={item.connector_id} data-testid="connector-update-review-item">
      <div className="font-medium text-foreground">{connectorDisplayName(item)}</div>
      <div className="mt-1 text-muted-foreground">
        {versionLabel(item.installed.version)} <code className="break-all font-mono">{item.installed.digest}</code>
        {" → "}
        {versionLabel(item.target.version)} <code className="break-all font-mono">{item.target.digest}</code>
      </div>
      <ul className="mt-1 list-disc pl-5 text-status-warning-fg">
        {(item.reasons.length ? item.reasons : ["review_required"]).map((reason) => (
          <li key={reason}>{reason === "review_required" ? "Review required" : reasonLabel(reason)}</li>
        ))}
      </ul>
      {diff ? (
        <dl className="mt-2 grid gap-1" data-testid="connector-update-manifest-diff">
          <FieldList fields={diff.added_fields} label="Added" />
          <FieldList fields={diff.removed_fields} label="Removed" />
          <FieldList fields={diff.changed_fields} label="Changed" />
          <div>
            <dt className="font-medium text-foreground">Compatibility</dt>
            <dd className="text-muted-foreground">{diff.compatibility}</dd>
          </div>
        </dl>
      ) : null}
      {onConfirm && !blocked ? (
        <IcButton className="mt-2" disabled={busy} onClick={() => onConfirm(item)} size="sm" type="button">
          {busy ? "Starting update…" : `Confirm update to ${versionLabel(item.target.version)}`}
        </IcButton>
      ) : null}
    </li>
  );
}

export function ReviewPanel({
  busyConnectorId = null,
  items,
  onConfirm,
}: {
  busyConnectorId?: string | null;
  items: readonly ConnectorUpdatePlanItem[];
  onConfirm?: (item: ConnectorUpdatePlanItem) => void;
}) {
  if (!items.length) {
    return null;
  }
  return (
    <details className="pdpp-caption mb-5" id="connector-update-review">
      <summary className="cursor-pointer text-status-warning-fg underline underline-offset-4">
        Review changes ({items.length})
      </summary>
      <ul className="mt-2 divide-y divide-border/60">
        {items.map((item) => (
          <ReviewItem
            busy={busyConnectorId === item.connector_id}
            item={item}
            key={item.connector_id}
            onConfirm={onConfirm}
          />
        ))}
      </ul>
    </details>
  );
}
