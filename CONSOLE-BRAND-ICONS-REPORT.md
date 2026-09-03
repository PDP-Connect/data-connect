# Console brand icons report

## Delivery

- Vendored `@pdpp/polyfill-connectors` from data-connectors commit `a39f33e6bbd3ba6c73af9e5512fc945beb3cc1d2`.
- Tarball SHA-256: `12fba07a33dfe34ba709346c3501f01bc55675afae31f1df98715ee03fa7a5c2`.
- Updated the root lockfile integrity and `reference-implementation/vendor/SHA256SUMS`.
- The reference server projects the vendored manifest `brand` declarations at `/connector-index.json`. The endpoint returned 45 `brandIcons` entries in the rebuilt preview.
- `ConnectorIcon` reads only that index, chooses `darkUrl` under `data-theme="dark"`, and uses Monogram when an index entry is absent or its image cannot render. It is used by Sources, Explore, source detail, and consent rows.
- Removed console consumption of the previous inline manifest-icon value. No connector-specific SVG assets remain under `apps/console`; the remaining `app/icon.svg` and `public/brand/pdpp-favicon.svg` are application identity assets.

## Validation

- ConnectorIcon unit test: 7 passed, 0 failed.
- Changed Sources model plus consent contract tests: 118 passed, 0 failed.
- Console typecheck: passed.
- Full console suite: 2,168 passed, 149 failed. The failures are pre-existing worktree-layout failures: tests require absent sibling `packages/polyfill-connectors`, `packages/pdpp-brand`, and `packages/operator-ui` paths.
- PostgreSQL consent journey oracle: 13 passed, 0 failed; consent challenge persistence oracle: 1 passed, 0 failed. Both used a disposable PostgreSQL 16 container and its provisioned test sentinel.
- Production console build in the `core` image: passed.

## Visual inspection

Captured `/sources?demo=mixed` at 1440px and 390px in light and dark under `~/.tmp/` using the local preview and checked the DOM theme attribute and ConnectorIcon output. The valid declared icons rendered on both viewports and themes. Two upstream SVGs observed in the demo (Gmail and Chase) omit an XML namespace and Chromium reports zero intrinsic width; the component degrades these to Monogram instead of showing a broken image.

The preview had no seeded consent challenge, so a populated consent-page capture could not be made without manufacturing authorization data outside this change. Consent row rendering is covered by the source contract test and shares ConnectorIcon.

## Image

- Disk gate before build: 182 GB available on `/`.
- Tag: `pdpp-console-brand-icons:a39f33e6`.
- Image ID: `sha256:ba35b10ec32478f678a6384edc5b03bccace116d6ce4ffdd6ea035e22ed1784f`.
- No running image or production container was swapped.
