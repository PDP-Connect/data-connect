// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import type { RefConnectorSummary } from "../../lib/ref-client.ts";
import { EmptyState } from "../empty-state.tsx";
import { DataList, PageHeader, Section } from "../primitives.tsx";

export interface SchedulesViewProps {
  description?: string;
  readOnlyNotice?: ReactNode;
  renderRow: (summary: RefConnectorSummary) => ReactNode;
  scheduledEmptyHint?: string;
  summaries: RefConnectorSummary[];
  unscheduledDescription: string;
}

export function SchedulesView({
  description,
  readOnlyNotice,
  renderRow,
  scheduledEmptyHint,
  summaries,
  unscheduledDescription,
}: SchedulesViewProps) {
  const withSchedule = summaries.filter((s) => s.schedule !== null);
  const unscheduled = summaries.filter((s) => s.schedule === null);
  const needsHumanCount = summaries.filter((s) => s.schedule?.human_attention_needed).length;

  return (
    <>
      <PageHeader
        count={`${withSchedule.length} scheduled · ${unscheduled.length} unscheduled`}
        description={description}
        title="Schedules"
      />

      {needsHumanCount > 0 && (
        <div className="pdpp-caption mb-6 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
          <strong>
            {needsHumanCount} connection{needsHumanCount === 1 ? "" : "s"} need human attention.
          </strong>{" "}
          Automatic runs are paused until you run them manually and provide the required input.
        </div>
      )}

      {readOnlyNotice}

      <Section title={`Scheduled connections (${withSchedule.length})`}>
        {withSchedule.length === 0 ? (
          <EmptyState hint={scheduledEmptyHint} title="No scheduled connections yet" />
        ) : (
          <DataList>{withSchedule.map((summary) => renderRow(summary))}</DataList>
        )}
      </Section>

      {unscheduled.length > 0 && (
        <Section description={unscheduledDescription} title={`Unscheduled connections (${unscheduled.length})`}>
          <DataList>{unscheduled.map((summary) => renderRow(summary))}</DataList>
        </Section>
      )}
    </>
  );
}
