// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isNavItemActive, NAV_ITEMS } from "@pdpp/brand-react";
import type { Breadcrumb } from "@pdpp/operator-ui/components/primitives";

/**
 * Breadcrumb trail for a console page, anchored in the sidebar's nav tree.
 *
 * The first crumb is the nav item that owns `pathname`, read from NAV_ITEMS (the
 * list the sidebar renders) with the same matcher the sidebar highlight uses. The
 * caller passes the crumbs below that item: parent entities by their human name,
 * then the page itself as the last crumb, with no href.
 *
 * A nav item's own route is top-level and gets no trail: the sidebar already shows
 * where it is. So does a route outside the nav tree.
 */
export function breadcrumbsFor(pathname: string, ...trail: Breadcrumb[]): Breadcrumb[] {
  const section = NAV_ITEMS.find((item) => isNavItemActive(item.href, pathname));
  if (!section || section.href === pathname) {
    return [];
  }
  return [{ href: section.href, label: section.label }, ...trail];
}
