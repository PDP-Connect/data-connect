"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { type WayRow, otherWays } from "./choose-way.ts";
import type { Inventory } from "./prepare-remote-access.ts";

type Capabilities = Parameters<typeof otherWays>[1];

function MissingStep({ row }: { row: WayRow }) {
  if (!row.missing) return null;
  return (
    <span className="pdpp-caption">
      {row.missing.text}
      {row.missing.link ? (
        <>
          {" "}
          <a href={row.missing.link.href} rel="noreferrer" target="_blank">
            {row.missing.link.label} ↗
          </a>
        </>
      ) : null}
    </span>
  );
}

function WayChoice({ row, checked, onPick }: { row: WayRow; checked: boolean; onPick: (providerId: string) => void }) {
  return (
    <label className={`grid gap-1 rounded-lg border p-3${row.usable ? "" : " text-muted-foreground"}`}>
      <span>
        <input checked={checked} disabled={!row.usable} name="way" onChange={() => onPick(row.providerId)} type="radio" />{" "}
        {row.title}
      </span>
      {row.line ? <span className="pdpp-caption">{row.line}</span> : null}
      <MissingStep row={row} />
    </label>
  );
}

/** The recommended way, above Turn on. It stays here when the owner picks another way below. */
export function RecommendedWay({
  row,
  checked,
  onPick,
}: {
  row: WayRow;
  checked: boolean;
  onPick: (providerId: string) => void;
}) {
  return (
    <section aria-label="Recommended way" className="grid gap-1 rounded-lg border p-3">
      <span>
        <input checked={checked} name="way" onChange={() => onPick(row.providerId)} type="radio" />{" "}
        <strong>{row.title}</strong> · Recommended
      </span>
      {row.line ? <span className="pdpp-caption">{row.line}</span> : null}
    </section>
  );
}

/** Other ways, in three groups. Advanced is closed until opened. */
export function OtherWays({
  inventory,
  capabilities,
  recommendedId,
  pickedId,
  disabled,
  onPick,
}: {
  inventory: Inventory;
  capabilities: Capabilities;
  recommendedId: string | null;
  pickedId: string | null;
  disabled: boolean;
  onPick: (providerId: string) => void;
}) {
  const groups = otherWays(inventory, capabilities, recommendedId);
  return (
    <fieldset className="grid gap-4" disabled={disabled}>
      <legend className="pdpp-label">Other ways</legend>
      {groups.map((group) => {
        const rows = group.rows.map((row) => (
          <WayChoice checked={pickedId === row.providerId} key={row.providerId} onPick={onPick} row={row} />
        ));
        if (group.rows.length === 0) return null;
        return group.id === "advanced" ? (
          <details key={group.id}>
            <summary>{group.title}</summary>
            <div className="grid gap-3">{rows}</div>
          </details>
        ) : (
          <section aria-label={group.title} className="grid gap-2" key={group.id}>
            <h4 className="pdpp-label">{group.title}</h4>
            <p className="pdpp-caption">{group.note}</p>
            {rows}
          </section>
        );
      })}
    </fieldset>
  );
}
