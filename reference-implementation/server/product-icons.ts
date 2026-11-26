// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The single definition of the product icon URLs the server advertises: the
// hosted-MCP `serverInfo.icons` and `Link: rel="icon"` header, and the default
// DCR `logo_uri`.
//
// The paths are the Next.js metadata routes of the console, not files. They
// are produced by `apps/console/src/app/icon.tsx` (served at `/icon`, always
// `image/svg+xml`, scalable) and `apps/console/src/app/apple-icon.tsx`
// (served at `/apple-icon`, always a 180x180 `image/png`). The product
// identity is fixed in code, so each file's `contentType`/`size` are
// constants; `product-icons.test.ts` checks that these constants agree with
// the console source, so a rename or format change there fails a test here.

export interface ProductIcon {
  readonly mimeType: string;
  /** Console metadata route, relative to the public origin. */
  readonly path: string;
  readonly sizes: readonly string[];
}

export const PRODUCT_ICON_SVG: ProductIcon = {
  mimeType: "image/svg+xml",
  path: "/icon",
  sizes: ["any"],
};

export const PRODUCT_ICON_PNG: ProductIcon = {
  mimeType: "image/png",
  path: "/apple-icon",
  sizes: ["180x180"],
};

export interface AdvertisedIcon {
  readonly mimeType: string;
  readonly sizes: readonly string[];
  readonly src: string;
}

export function productIconUrl(origin: string, icon: ProductIcon): string {
  return new URL(icon.path, origin).toString();
}

/** MCP `serverInfo.icons`: SVG first, PNG for clients that cannot render SVG. */
export function productServerIcons(origin: string): readonly AdvertisedIcon[] {
  return [PRODUCT_ICON_SVG, PRODUCT_ICON_PNG].map((icon) => ({
    mimeType: icon.mimeType,
    sizes: icon.sizes,
    src: productIconUrl(origin, icon),
  }));
}

/** `Link` header value advertising the SVG icon. */
export function productIconLinkHeader(origin: string): string {
  return `<${productIconUrl(origin, PRODUCT_ICON_SVG)}>; rel="icon"; type="${PRODUCT_ICON_SVG.mimeType}"`;
}
