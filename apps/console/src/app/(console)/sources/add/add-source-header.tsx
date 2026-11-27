// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { ADD_SOURCE_COPY } from "./add-source-list-model.ts";

/** Title, breadcrumb and lead of "Add a data source"; shared by the page and its error boundary. */
export function AddSourceHeader() {
  return (
    <PageHeader
      breadcrumbs={[
        { href: dashboardRoutes.section.overview, label: "Home" },
        { href: dashboardRoutes.section.records, label: "Data sources" },
        { label: ADD_SOURCE_COPY.heading },
      ]}
      description={ADD_SOURCE_COPY.lead}
      title={ADD_SOURCE_COPY.heading}
    />
  );
}
