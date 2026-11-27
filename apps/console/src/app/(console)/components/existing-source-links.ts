// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RefCountState } from "../lib/ref-client.ts";

export interface ExistingSourceSetupLink {
  connectionId: string;
  displayName: string;
  latestImportFile: string | null;
  latestImportStatus: string | null;
  status: string | null;
  totalRecords: number;
  /**
   * Orthogonal state for `totalRecords` (Sol fourth-verdict P1.3).
   * `undefined` for a reference predating this field, preserving the exact
   * prior always-numeric rendering.
   */
  totalRecordsState?: RefCountState;
}

export interface UncataloguedSourceSetupLink {
  connectorId: string;
  connectionId: string;
  displayName: string;
}

export interface SourceSummaryRead {
  byConnector: Readonly<Record<string, readonly ExistingSourceSetupLink[]>>;
  truncated: boolean;
  uncataloguedSources?: readonly UncataloguedSourceSetupLink[];
}
