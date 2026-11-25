"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcInput } from "@pdpp/brand-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ConnectorMark } from "../../components/connector-mark.tsx";
import {
  ADD_SOURCE_COPY,
  type AddSourceListModel,
  type AddSourceRow,
  cannotAddCopy,
  noMatchCopy,
  searchAddSourceList,
} from "./add-source-list-model.ts";

function Row({ row }: { row: AddSourceRow }) {
  return (
    <li className="border-b border-border" data-testid={`add-source-row-${row.connectorKey}`}>
      <Link className="flex min-h-11 min-w-0 items-center gap-3 py-3 hover:bg-muted/40" href={row.href}>
        <ConnectorMark connectorId={row.connectorKey} icon={row.icon} name={row.displayName} />
        <span className="min-w-0 flex-1 truncate text-foreground">{row.displayName}</span>
        {row.added ? <span className="pdpp-caption text-muted-foreground">Added</span> : null}
      </Link>
    </li>
  );
}

const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

/** Quiet rows of the same height as real rows; no spinner text. */
export function AddSourceListSkeleton() {
  return (
    <ul aria-hidden className="grid" data-testid="add-source-list-loading">
      {SKELETON_ROWS.map((id) => (
        <li className="flex min-h-11 items-center gap-3 border-b border-border py-3" key={id}>
          <span className="size-6 rounded-sm bg-muted/60" />
          <span className="h-4 w-40 rounded-sm bg-muted/60" />
        </li>
      ))}
    </ul>
  );
}

export function AddSourceList({ model, query }: { model: AddSourceListModel; query: string }) {
  const [searchText, setSearchText] = useState(query);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setSearchText(query), [query]);
  useEffect(() => input.current?.focus(), []);
  const update = (value: string) => {
    setSearchText(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("source_q", value);
    else url.searchParams.delete("source_q");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const result = searchAddSourceList(model, searchText);
  return (
    <div className="grid gap-4">
      <label className="sr-only" htmlFor="source_q">
        {ADD_SOURCE_COPY.searchPlaceholder}
      </label>
      <IcInput
        autoComplete="off"
        className="min-w-0 max-w-md"
        id="source_q"
        name="source_q"
        onChange={(event) => update(event.currentTarget.value)}
        placeholder={ADD_SOURCE_COPY.searchPlaceholder}
        ref={input}
        type="search"
        value={searchText}
      />
      {result.kind === "rows" ? (
        <ul className="grid" data-testid="add-source-list">
          {result.rows.map((row) => (
            <Row key={row.connectorKey} row={row} />
          ))}
        </ul>
      ) : (
        <p className="pdpp-caption py-2 text-muted-foreground" data-testid="add-source-empty" role="status">
          {result.kind === "cannot-add" ? cannotAddCopy(result.name) : noMatchCopy(result.query)}
        </p>
      )}
    </div>
  );
}

export function AddSourceLoadFailed() {
  return (
    <div className="grid gap-2 py-3" data-testid="add-source-load-failed">
      <p className="pdpp-caption text-muted-foreground" role="alert">{ADD_SOURCE_COPY.loadFailed}</p>
      <div>
        <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/sources/add">
          {ADD_SOURCE_COPY.retry}
        </Link>
      </div>
    </div>
  );
}
