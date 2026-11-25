"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { Button } from "@/components/ui/button.tsx";
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
function WayChoice({ row, checked, onPick }: { row: WayRow; checked: boolean; onPick: (providerId: string) => void }) {
  return (
    <label
      className={`grid cursor-pointer gap-1 border-b border-border/70 py-3 transition-colors has-[input:focus-visible]:bg-muted ${checked ? "text-foreground" : "text-muted-foreground"} ${row.usable ? "" : "opacity-60"}`}
    >
      <span className="flex items-start gap-3">
        <input
          checked={checked}
          className="mt-0.5 accent-primary"
          disabled={!row.usable}
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

function OutcomeChoice({
  title,
  line,
  row,
  checked,
  disabled,
  onPick,
}: {
  title: string;
  line: string;
  row: WayRow;
  checked: boolean;
  disabled: boolean;
  onPick: (providerId: string) => void;
}) {
  return (
    <Button
      aria-pressed={checked}
      className="h-auto min-h-11 w-full justify-start rounded-none border-b border-border/70 px-0 py-3 text-left"
      disabled={disabled || !row.usable}
      onClick={() => onPick(row.providerId)}
      type="button"
      variant="ghost"
    >
      <span className="grid gap-1 whitespace-normal">
        <span className="text-[15px] font-medium text-foreground">{title}</span>
        <span className="text-[13px] font-normal text-muted-foreground">{line}</span>
      </span>
    </Button>
  );
}

export function OutcomeWays({
  phone,
  chatgpt,
  pickedId,
  disabled,
  onPick,
}: {
  phone: WayRow;
  chatgpt: WayRow;
  pickedId: string | null;
  disabled: boolean;
  onPick: (providerId: string) => void;
}) {
  return (
    <section aria-label="Choose how to use remote access" className="grid gap-1">
      <OutcomeChoice
        checked={pickedId === phone.providerId}
        disabled={disabled}
        line={phone.line || "Free. Needs a Tailscale account."}
        onPick={onPick}
        row={phone}
        title="Use DataConnect from my phone"
      />
      <OutcomeChoice
        checked={pickedId === chatgpt.providerId}
        disabled={disabled}
        line={chatgpt.line || "Needs a web address that ChatGPT can open."}
        onPick={onPick}
        row={chatgpt}
        title="Let ChatGPT reach it"
      />
    </section>
  );
}

/** The recommended way, above Turn on. It stays here when the owner picks another way below. */
export function RecommendedWay({
  row,
  checked,
  disabled,
  onPick,
}: {
  row: WayRow;
  checked: boolean;
  disabled: boolean;
  onPick: (providerId: string) => void;
}) {
  return (
    <section aria-label="Recommended way" className="grid gap-1">
      <label className="grid cursor-pointer gap-1 border-b border-border/70 py-3 has-[input:focus-visible]:bg-muted">
        <span className="flex items-start gap-3">
          <input
            aria-label={row.title}
            checked={checked}
            className="mt-0.5 accent-primary"
            disabled={disabled}
            name="way"
            onChange={() => onPick(row.providerId)}
            type="radio"
            value={row.providerId}
          />
          <span className="grid gap-1.5">
            <span className="text-[15px] font-medium">{row.title}</span>
            {row.line ? <span className="pdpp-caption">{row.line}</span> : null}
          </span>
        </span>
      </label>
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
  blocks,
  onPick,
}: {
  inventory: Inventory;
  capabilities: Capabilities;
  blocks: Blocks;
  recommendedId: string | null;
  pickedId: string | null;
  disabled: boolean;
  onPick: (providerId: string) => void;
}) {
  const groups = otherWays(inventory, capabilities, recommendedId, blocks);
  return (
    <fieldset className="grid gap-4" disabled={disabled}>
      <legend className="pdpp-label">Other ways</legend>
      {groups.map((group) => {
        const rows = group.rows.map((row) => (
          <WayChoice checked={pickedId === row.providerId} key={row.providerId} onPick={onPick} row={row} />
        ));
        if (group.rows.length === 0) return null;
        return group.id === "advanced" ? (
          <details className="grid gap-2" key={group.id}>
            <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-medium">
              <span>
                {group.title}
                <span className="font-normal text-[13px] text-muted-foreground"> · {group.rows.map((row) => row.title).join(", ")}</span>
              </span>
              <span aria-hidden="true">›</span>
            </summary>
            <div className="grid gap-2.5">{rows}</div>
          </details>
        ) : (
          <section aria-label={group.title} className="grid gap-2" key={group.id}>
            <div className="grid gap-0.5">
              <h4 className="text-[13px] font-medium text-muted-foreground">{group.title}</h4>
              {group.note ? <p className="text-[13px] text-muted-foreground">{group.note}</p> : null}
            </div>
            <div className="grid gap-2.5">{rows}</div>
          </section>
        );
      })}
    </fieldset>
  );
}
