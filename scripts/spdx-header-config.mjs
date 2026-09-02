// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for which first-party source files require an
 * Apache-2.0 SPDX header, and which are exempt.
 *
 * Read by both the one-off sweep (git history, PR #4) and the recurring
 * guard (scripts/check-spdx-headers.mjs / CI). Keep exclusions here only —
 * do not duplicate this list or re-derive it separately in either consumer.
 */

// File extensions considered first-party source for header purposes. Matches
// the scope PR #4 (chore: add Apache-2.0 SPDX license headers) established.
export const SOURCE_EXTENSIONS = [
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".sh",
  ".css",
]

// Path segments that, if present anywhere in a file's path, exclude it.
// These are never first-party source: dependency trees and build output.
export const EXCLUDED_PATH_SEGMENTS = ["node_modules", "dist", "build", "vendor"]

// Exact repo-relative file paths excluded from the header requirement, with
// the reason documented inline. Grouped by exclusion class from PR #4:
//   1. vendor / bundled-connector / third-party-icon / UI-primitive files
//   2. generated files
//   3. fixture files
//   6. binary test fixture data (not a source extension, listed for completeness)
export const EXCLUDED_FILES = new Set([
  // -- vendored agent-skill package (external, ships its own LICENSE.txt) --
  ".agents/skills/chrome-cdp/scripts/cdp.mjs",

  // -- fixture files --
  "personal-server/pdpp/test/fixtures/chatgpt.collection-profile.js",
  "src-tauri/tests/fixtures/chatgpt-pdpp-browser.fixture.mjs",
  "src-tauri/tests/fixtures/pdpp-connector-fixture.mjs",

  // -- third-party platform/brand icon SVGs (not DataConnect/Vana marks) --
  "src/components/icons/icon-discord.tsx",
  "src/components/icons/icon-instagram.tsx",
  "src/components/icons/icon-x.tsx",
  "src/components/icons/platform-apple.tsx",
  "src/components/icons/platform-chatgpt.tsx",
  "src/components/icons/platform-github.tsx",
  "src/components/icons/platform-google-drive.tsx",
  "src/components/icons/platform-google-play.tsx",
  "src/components/icons/platform-instagram-glyph.tsx",
  "src/components/icons/platform-instagram.tsx",
  "src/components/icons/platform-linkedin.tsx",
  "src/components/icons/platform-netflix-black.tsx",
  "src/components/icons/platform-netflix.tsx",
  "src/components/icons/platform-shop.tsx",
  "src/components/icons/platform-spotify.tsx",

  // -- shadcn/radix UI primitives (vendored scaffolding, not app logic) --
  "src/components/ui/alert-dialog.tsx",
  "src/components/ui/badge.tsx",
  "src/components/ui/button.tsx",
  "src/components/ui/card.tsx",
  "src/components/ui/combobox.tsx",
  "src/components/ui/dropdown-menu.tsx",
  "src/components/ui/field.tsx",
  "src/components/ui/input-group.tsx",
  "src/components/ui/input.tsx",
  "src/components/ui/label.tsx",
  "src/components/ui/select.tsx",
  "src/components/ui/separator.tsx",
  "src/components/ui/sonner.tsx",
  "src/components/ui/switch.tsx",
  "src/components/ui/tabs.tsx",
  "src/components/ui/textarea.tsx",
  "src/components/ui/tooltip.tsx",

  // -- generated file --
  "src/lib/platform/registry.generated.ts",

  // -- generated test-discovery stubs (each re-exports a headered .source.ts
  //    or .ts sibling; the header lives on that real source file) --
  "reference-implementation/scripts/quality-ratchet/check-mass-ratchet.test.mjs",
  "reference-implementation/scripts/quality-ratchet/measure-mass.test.mjs",
  "reference-implementation/scripts/quality-ratchet/regenerate-mass-baseline.test.mjs",
  "reference-implementation/scripts/requeue-quarantined-detail-gaps.test.mjs",
])

export function isExcludedPath(relativePath) {
  const segments = relativePath.split("/")
  if (segments.some(segment => EXCLUDED_PATH_SEGMENTS.includes(segment))) {
    return true
  }
  return EXCLUDED_FILES.has(relativePath)
}
