"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { type Blocks, type WayRow, otherWays } from "./choose-way.ts";
import type { Inventory } from "./prepare-remote-access.ts";

type Capabilities = Parameters<typeof otherWays>[1];

function MissingStep({ row }: { row: WayRow }) {
  if (!row.missing) return null;
  return (
    <span className="text-[13px] text-attention">
      {row.missing.text}
      {row.missing.link ? (
        <>
          {" "}
          <a className="underline underline-offset-4" href={row.missing.link.href} rel="noreferrer" target="_blank">
            {row.missing.link.label} ↗
          </a>
        </>
      ) : null}
    </span>
  );
}

/** One way, as a selectable card: the picked one is outlined and tinted, a way that cannot run says why. */
function WayChoice({ row, checked, onPick, disabled = false }: { row: WayRow; checked: boolean; disabled?: boolean; onPick: (providerId: string) => void }) {
  return (
    <label
      className={`grid cursor-pointer gap-1 border-b border-border/70 py-3 transition-colors has-[input:focus-visible]:bg-muted ${checked ? "text-foreground" : "text-muted-foreground"} ${row.usable ? "" : "opacity-60"}`}
    >
      <span className="flex items-start gap-3">
        <input
          aria-label={row.title}
          checked={checked}
          className="mt-0.5 accent-primary"
          disabled={disabled || !row.usable}
          name="way"
          onChange={() => onPick(row.providerId)}
          type="radio"
          value={row.providerId}
        />
        <span className="grid gap-1">
          <span className="text-sm font-medium">{row.title}</span>
          {row.line ? <span className="pdpp-caption">{row.line}</span> : null}
        </span>
      </span>
      <MissingStep row={row} />
    </label>
  );
}

export function WaysList({ inventory, capabilities, blocks, pickedId, disabled, onPick }: {
  inventory: Inventory; capabilities: Capabilities; blocks: Blocks; pickedId: string | null; disabled: boolean; onPick: (providerId: string) => void;
}) {
  const groups = otherWays(inventory, capabilities, null, blocks);
  return <fieldset aria-label="Choose a way" className="grid gap-1" disabled={disabled}><legend className="text-sm">Choose a way</legend>{groups.flatMap(group => group.rows).map(row => <WayChoice key={row.providerId} row={row} disabled={disabled} checked={pickedId === row.providerId} onPick={onPick} />)}</fieldset>;
}
