// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";

const ROW_KEYS = ["a", "b", "c", "d", "e"];

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-muted ${className}`} />;
}

/**
 * Sync history while it loads: the page's own header, the filters one per
 * line, a day heading, then plain rows (logo, name, a line of facts). The same
 * order and stacking as the page at phone width.
 */
export function SyncHistoryLoadingSkeleton() {
  return (
    <div aria-busy="true" className="min-w-0">
      <span className="sr-only" role="status">Loading sync history…</span>
      <PageHeader description="What DataConnect did to keep your copies up to date." title="Sync history" />
      <div className="mb-6 flex flex-col gap-4">
        <Bar className="h-11 w-full rounded-md" />
        <Bar className="h-11 w-40 rounded-md" />
        <Bar className="h-11 w-full rounded-md" />
      </div>
      <Bar className="mb-3 h-5 w-20" />
      <ul className="divide-y divide-border/70">
        {ROW_KEYS.map((key) => (
          <li className="flex items-start gap-3 py-4" key={key}>
            <Bar className="h-8 w-8 shrink-0 rounded-md" />
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Bar className="h-4 w-40 max-w-[60%]" />
              <Bar className="h-3 w-56 max-w-[80%]" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
