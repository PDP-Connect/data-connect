// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-muted ${className}`} />;
}

/**
 * The first-sync page while it loads: the trail and a title block where the
 * page's title lands (the title says the outcome, so it waits for the data),
 * then the lines and buttons that follow. The last trail step is the data
 * source's name, which also waits for the data, so the trail stops at Data sources.
 */
export function FirstSyncLoadingSkeleton() {
  return (
    <div aria-busy="true" className="[&>header]:mb-0">
      <span className="sr-only" role="status">Loading your first sync…</span>
      <PageHeader
        breadcrumbs={[
          { href: dashboardRoutes.section.overview, label: "Home" },
          { href: dashboardRoutes.section.records, label: "Data sources" },
        ]}
        title={<span className="inline-flex items-center gap-2"><Bar className="h-8 w-8 shrink-0 rounded-md" /><Bar className="h-7 w-56 max-w-[70%]" /></span>}
      />
      <div className="grid max-w-xl gap-4 pb-4 pt-6">
        <Bar className="h-4 w-72 max-w-full" />
        <Bar className="h-4 w-56 max-w-[80%]" />
        <Bar className="h-11 w-40 rounded-md" />
      </div>
    </div>
  );
}
