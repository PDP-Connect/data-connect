// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existingSourcesByConnectorCatalog } from "../../components/existing-sources-by-connector.ts";
import type { SourceSummaryRead } from "../../components/existing-source-links.ts";

export function readInstalledSourceCatalog(catalogConnectorIds: readonly string[]): Promise<SourceSummaryRead> {
  return existingSourcesByConnectorCatalog(catalogConnectorIds);
}
