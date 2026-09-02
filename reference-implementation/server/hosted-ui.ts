// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted-UI layer for the reference server.
 *
 * Small, boring, server-rendered UI helpers shared by every hosted HTML
 * page (`/consent`, `/device`, consent/device result pages, `/owner/login`).
 * These pages are reference-only surfaces, not PDPP protocol surfaces.
 *
 * Design intent:
 *   - reuse the PDPP brand language (tokens, typography classes, semantic
 *     surfaces) from `packages/pdpp-brand/` (`components.css` for surfaces)
 *   - no framework, no hydration — plain strings and one stylesheet
 *   - do not fork the design system for hosted pages; keep the hosted-ui
 *     layer minimal and clearly prefixed (`hosted-ui-*`)
 *
 * Shared stylesheet is served by the AS app at `/__pdpp/hosted-ui.css`
 * (see `HOSTED_UI_CSS_PATH` and `HOSTED_UI_CSS`).
 */

export const HOSTED_UI_CSS_PATH = "/__pdpp/hosted-ui.css";
export const HOSTED_UI_BRAND_MARKER = "data-pdpp-hosted-ui";
export const HOSTED_UI_THEME_COOKIE_NAME = "pdpp-theme";

type HostedThemeChoice = "light" | "dark" | "system";

interface HostedDocumentArgs {
  body: string;
  providerName: unknown;
  themeChoice?: unknown;
  title: unknown;
}

interface PageIntroArgs {
  eyebrow?: unknown;
  lede?: unknown;
  title?: unknown;
}
interface SurfaceArgs {
  ariaLabel?: unknown;
  children?: string;
  surface?: unknown;
}
type KeyValueItem = { label: unknown; value?: unknown; html?: string } | null | undefined;
interface ActionField {
  name: unknown;
  value?: unknown;
}
interface Action {
  action?: unknown;
  hidden?: ActionField[];
  href?: unknown;
  label: unknown;
  method?: unknown;
  variant?: unknown;
}
interface ResultStateArgs {
  body?: unknown;
  footnote?: unknown;
  glyph?: unknown;
  title?: unknown;
  tone?: "success" | "neutral" | "danger";
}
interface EmptyStateField {
  autocomplete?: unknown;
  autofocus?: boolean;
  label: unknown;
  name: unknown;
  type?: unknown;
  value?: unknown;
}
interface EmptyStateForm {
  action?: unknown;
  fields?: EmptyStateField[];
  hidden?: ActionField[];
  method?: unknown;
  submitLabel?: unknown;
}
interface EmptyStateArgs {
  body?: unknown;
  form?: EmptyStateForm;
  title?: unknown;
}

function isRenderableKeyValueItem(item: KeyValueItem): item is Exclude<KeyValueItem, null | undefined> {
  if (!item) {
    return false;
  }
  return Boolean(item.html) || (item.value !== null && item.value !== undefined && item.value !== "");
}

export function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── PDPP mark (server-side SVG) ─────────────────────────────────────────────
// Geometry mirrors apps/site/src/components/PdppLogo.tsx so the reference
// pages carry the same mark as the website. Keep in sync.

// Ink Carbon values (apps/console/src/styles/ink-carbon.css light mode) —
// keep these three in sync with that file's --human / --primary / --background.
const HUMAN = "oklch(0.55 0.11 45)";
const PROTOCOL = "oklch(0.46 0.11 255)";
const COUNTER = "oklch(0.985 0.004 90)";

export function renderPdppMark({ size = 28, title = "PDPP" } = {}) {
  const safeTitle = escapeHtml(title);
  const labelAttr = title ? `role="img" aria-label="${safeTitle}"` : 'role="presentation" aria-hidden="true"';
  return (
    `<svg class="hosted-ui-mark" viewBox="0 0 200 200" width="${size}" height="${size}" ${labelAttr}>` +
    `<path d="M 40 30 L 40 170 L 60 170 L 60 116 L 100 116 Q 105 116 105 110 L 105 30 Z" fill="${HUMAN}"/>` +
    `<path d="M 105 30 L 105 110 Q 105 116 100 116 L 60 116 L 60 170 L 80 170 L 80 136 L 125 136 Q 155 136 155 103 Q 155 30 105 30 Z" fill="${PROTOCOL}"/>` +
    `<circle cx="105" cy="73" r="18" fill="${COUNTER}"/>` +
    "</svg>"
  );
}

// ─── Shared CSS ──────────────────────────────────────────────────────────────
// Minimal PDPP subset derived from packages/pdpp-brand/styles/base.css plus a tiny
// hosted-ui layer. No fontsource imports — these pages fall back to system UI
// until font weights load from the website. Reference-only by design.

// Values below mirror apps/console/src/styles/ink-carbon.css (:root and
// [data-theme="dark"]) so a hosted page and the console render the same
// palette, radii, and font stack. Font stack has no web-font fetch — the
// hosted UI is a security-sensitive first-party surface and does not load
// third-party font CDNs; it falls back to the closest installed system
// faces until (if ever) fonts are self-hosted.
export const HOSTED_UI_CSS = `:root {
  /* Named faces only where they resolve without a fetch. The stack used to
   * lead with "Inter" and "JetBrains Mono" while importing neither, so every
   * hosted page rendered in system UI under a stylesheet that claimed
   * otherwise. This surface deliberately loads no third-party font CDN — it
   * is a security-sensitive first-party auth surface — so the honest stack is
   * the system one, which on the platforms the console targets resolves to
   * very nearly the same shapes. */
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  --background: oklch(0.985 0.004 90);
  --foreground: oklch(0.18 0.005 270);
  --card: oklch(1 0 0);
  --primary: oklch(0.46 0.11 255);
  --primary-foreground: oklch(0.99 0.002 90);
  --muted: oklch(0.955 0.004 270);
  --muted-foreground: oklch(0.47 0.008 270);
  --destructive: oklch(0.52 0.16 27);
  --destructive-foreground: oklch(0.99 0.002 90);
  --border: oklch(0.905 0.005 270);
  --input: oklch(0.79 0.006 270);
  --success: oklch(0.5 0.11 158);
  --warning: oklch(0.58 0.13 70);
  --human: oklch(0.55 0.11 45);
  --human-foreground: oklch(0.99 0.005 90);
  --human-wash: oklch(0.55 0.11 45 / 0.08);
  --radius: 0px;
  --radius-control: 2px;
  color-scheme: light;
}

html[data-theme="dark"] {
  --background: oklch(0.17 0.006 262);
  --foreground: oklch(0.95 0.005 262);
  --card: oklch(0.21 0.007 262);
  --primary: oklch(0.74 0.13 255);
  --primary-foreground: oklch(0.15 0.01 262);
  --muted: oklch(0.24 0.007 262);
  --muted-foreground: oklch(0.72 0.01 262);
  --destructive: oklch(0.7 0.16 27);
  --destructive-foreground: oklch(0.15 0.01 262);
  --border: oklch(0.29 0.008 262);
  --input: oklch(0.34 0.008 262);
  --success: oklch(0.76 0.13 158);
  --warning: oklch(0.8 0.14 75);
  --human: oklch(0.76 0.12 45);
  --human-foreground: oklch(0.16 0.01 45);
  --human-wash: oklch(0.76 0.12 45 / 0.11);
  color-scheme: dark;
}

@media (prefers-color-scheme: dark) {
  html[data-theme="system"] {
    --background: oklch(0.17 0.006 262);
    --foreground: oklch(0.95 0.005 262);
    --card: oklch(0.21 0.007 262);
    --primary: oklch(0.74 0.13 255);
    --primary-foreground: oklch(0.15 0.01 262);
    --muted: oklch(0.24 0.007 262);
    --muted-foreground: oklch(0.72 0.01 262);
    --destructive: oklch(0.7 0.16 27);
    --destructive-foreground: oklch(0.15 0.01 262);
    --border: oklch(0.29 0.008 262);
    --input: oklch(0.34 0.008 262);
    --success: oklch(0.76 0.13 158);
    --warning: oklch(0.8 0.14 75);
    --human: oklch(0.76 0.12 45);
    --human-foreground: oklch(0.16 0.01 45);
    --human-wash: oklch(0.76 0.12 45 / 0.11);
    color-scheme: dark;
  }
}

*, *::before, *::after { box-sizing: border-box; }

html {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
}

a { color: inherit; }
code, pre, kbd, samp { font-family: var(--font-mono); }

/* ─── PDPP type scale (subset) ──────────────────────────────────────── */
.pdpp-display {
  font-size: 2.5rem; font-weight: 600; line-height: 1.08; letter-spacing: -0.025em;
}
.pdpp-heading {
  font-size: 1.25rem; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em;
}
.pdpp-title {
  font-size: 0.875rem; font-weight: 600; line-height: 1.4;
}
.pdpp-body-lg {
  font-size: 1.0625rem; font-weight: 400; line-height: 1.6;
}
.pdpp-body {
  font-size: 0.9375rem; font-weight: 400; line-height: 1.6;
}
.pdpp-label {
  font-size: 0.75rem; font-weight: 500; line-height: 1.4;
}
.pdpp-caption {
  font-size: 0.75rem; font-weight: 400; line-height: 1.5;
  color: var(--muted-foreground);
}
.pdpp-eyebrow {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}

/* ─── Semantic surfaces (mirrors Ink Carbon's [data-surface] in
   apps/console/src/app/globals.css — square paper, left-rule accent,
   no shadow, no rounding) ──────────────────────────────────────── */
[data-surface="human"] {
  border: 1px solid var(--border);
  border-left: 2px solid var(--human);
  background-color: var(--card);
  border-radius: var(--radius);
}

[data-surface="protocol"] {
  border: 1px solid var(--border);
  border-left: 2px solid var(--primary);
  background-color: var(--card);
  border-radius: var(--radius);
}

/* ─── Authorship classes (three-class trust model) ──────────────────────
 * Each consent block names its provenance with a data-authorship attribute so
 * the three classes — protocol facts, manifest-authored descriptions, and
 * client-authored claims — stay visually and semantically distinct. The dashed
 * left rule on client blocks is the non-color affordance for claimed, not
 * enforced. */
.hosted-ui-authorship {
  padding-left: 0.75rem;
  border-left: 2px solid var(--border);
}
.hosted-ui-authorship + .hosted-ui-authorship { margin-top: 0.875rem; }
.hosted-ui-authorship-eyebrow { display: block; margin-bottom: 0.375rem; }
.hosted-ui-authorship[data-authorship="protocol"] { border-left-color: var(--primary); }
.hosted-ui-authorship[data-authorship="manifest"] { border-left-color: var(--human); }
.hosted-ui-authorship[data-authorship="client"] {
  border-left-style: dashed;
  border-left-color: var(--muted-foreground);
}
.hosted-ui-authorship[data-authorship="client"] .hosted-ui-authorship-eyebrow {
  color: var(--muted-foreground);
}
.hosted-ui-client-claim + .hosted-ui-client-claim { margin-top: 0.5rem; }
.hosted-ui-client-claim-disclaimer {
  margin-top: 0.5rem;
  font-style: italic;
  font-size: 0.75rem;
  color: var(--muted-foreground);
}

/* ─── Client identity header (monogram + unverified badge) ──────────────
 * Text-only monogram placeholder — never a remote client-supplied logo, per
 * client-display:676 (untrusted logo_uri MUST NOT be fetched/rendered for an
 * unverified client). */
.hosted-ui-client-identity {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}
.hosted-ui-client-monogram {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: var(--radius);
  background: var(--muted, oklch(0.94 0.005 85));
  color: var(--muted-foreground);
  font-weight: 600;
  font-size: 0.9375rem;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
.hosted-ui-client-identity-body {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}
.hosted-ui-client-identity-name {
  font-weight: 600;
  font-size: 1rem;
}
.hosted-ui-client-identity-domain {
  font-size: 0.8125rem;
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
/* Trust status as a neutral fact line, not a badge. The unverified state is
 * unconditional today (no trust registry exists), and a badge that cannot
 * vary reads as a warning about an app that has done nothing wrong. */
.hosted-ui-client-trust {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}
.hosted-ui-client-trust[data-trust="registered"] {
  color: var(--human, var(--foreground));
  font-weight: 600;
}
.hosted-ui-client-policy-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 0.5rem;
  font-size: 0.8125rem;
}
.hosted-ui-client-policy-links a {
  color: var(--muted-foreground);
  text-decoration: underline;
}

/* ─── Hosted-ui layout ──────────────────────────────────────────────── */
.hosted-ui-page {
  max-width: 640px;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.hosted-ui-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding-bottom: 0.25rem;
}

/* The instance is the header's only identity, so it carries the weight the
 * PDPP wordmark used to take. */
.hosted-ui-provider {
  font-weight: 600;
  font-size: 0.9375rem;
  letter-spacing: -0.01em;
  color: var(--foreground);
}

.hosted-ui-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  color: var(--muted-foreground);
}
.hosted-ui-footer-attribution {
  font-size: 0.75rem;
  letter-spacing: 0.01em;
}

.hosted-ui-mark { display: block; }

/* Allow and Cancel as a pair, primary rightmost. */
.hosted-ui-decision-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.5rem;
}

.hosted-ui-intro {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.hosted-ui-intro .pdpp-body-lg {
  color: var(--muted-foreground);
  max-width: 50ch;
}

.hosted-ui-surface {
  padding: 1.25rem 1.25rem 1.125rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.hosted-ui-surface > * + * { margin-top: 0; }

.hosted-ui-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.375rem 1rem;
  margin: 0;
  padding: 0;
}
.hosted-ui-kv dt {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted-foreground);
}
.hosted-ui-kv dd {
  font-size: 0.875rem;
  margin: 0;
  color: var(--foreground);
  word-break: break-word;
}
.hosted-ui-kv code {
  font-size: 0.8125rem;
  color: var(--foreground);
}

.hosted-ui-streams {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.hosted-ui-streams li {
  border: 1px solid var(--border);
  background: var(--card);
  border-radius: var(--radius);
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
}
.hosted-ui-streams .hosted-ui-stream-name {
  font-family: var(--font-mono);
  font-weight: 500;
  color: var(--foreground);
}
.hosted-ui-streams .hosted-ui-stream-meta {
  color: var(--muted-foreground);
  margin-left: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.hosted-ui-option-group {
  display: grid;
  gap: 0.625rem;
  margin: 0 0 1rem;
}

.hosted-ui-option {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.75rem;
  align-items: start;
  padding: 0.75rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
  cursor: pointer;
}

.hosted-ui-option:hover {
  background: var(--muted);
}

.hosted-ui-option:has(input:checked) {
  border-color: var(--primary);
  box-shadow: 0 0 0 1px var(--primary);
}

.hosted-ui-option input {
  margin: 0.2rem 0 0;
  accent-color: var(--primary);
}

.hosted-ui-option-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.hosted-ui-option-title {
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.35;
  color: var(--foreground);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 0.35rem;
}

.hosted-ui-connector-type {
  color: var(--foreground);
}

.hosted-ui-connection-name {
  font-weight: 400;
  font-size: 0.875rem;
  color: var(--muted-foreground);
}

.hosted-ui-connection-name::before {
  content: '·';
  margin-right: 0.35rem;
  color: var(--muted-foreground);
}

.hosted-ui-option-meta {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}

/* Per-row provenance, shown ONLY where rows genuinely differ. The uniform
 * "connector" badge and its "All sources below are connector-backed" summary
 * are gone: source.kind's audience is the client, and a value identical on
 * every row carried zero bits while occupying a slot on all of them. What
 * survives is the mixed-kind case, worded as a consequence for the owner
 * rather than as the raw enum. */
.hosted-ui-option-source-kind {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: var(--muted-foreground);
}
.hosted-ui-fields-timerange-summary {
  margin: 0 0 0.5rem;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}

.hosted-ui-option-source {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.25rem 0.75rem 0.75rem;
  margin: 0;
  background: var(--card);
}
.hosted-ui-option-source-legend {
  padding: 0 0.25rem;
  display: block;
  width: 100%;
}
.hosted-ui-option-source-legend .hosted-ui-option {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0.5rem 0.25rem;
  margin: 0;
}
.hosted-ui-option-source-legend .hosted-ui-option:hover {
  background: transparent;
}
.hosted-ui-option-source-legend .hosted-ui-option:has(input:checked) {
  border: none;
  box-shadow: none;
}

.hosted-ui-option-streams {
  display: grid;
  gap: 0.375rem;
  padding: 0.5rem 0.25rem 0.25rem 1.75rem;
  border-top: 1px dashed var(--border);
}

.hosted-ui-option-streams-empty {
  margin: 0.5rem 0 0;
  padding: 0 0.25rem 0.25rem 1.75rem;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}

.hosted-ui-stream-option {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.625rem;
  align-items: start;
  font-size: 0.8125rem;
  padding: 0.25rem 0;
  cursor: pointer;
}
.hosted-ui-stream-option input {
  margin: 0.2rem 0 0;
  accent-color: var(--primary);
}
.hosted-ui-stream-option-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.hosted-ui-access-mode {
  display: grid;
  gap: 0.375rem;
  margin: 0 0 1rem;
  padding: 0.625rem 0.875rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
}
.hosted-ui-access-mode-legend {
  padding: 0 0.25rem;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.025em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}
.hosted-ui-access-mode-option {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.625rem;
  align-items: start;
  padding: 0.375rem 0.25rem;
  cursor: pointer;
  font-size: 0.8125rem;
}
.hosted-ui-access-mode-option input {
  margin: 0.2rem 0 0;
  accent-color: var(--primary);
}
.hosted-ui-access-mode-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}
.hosted-ui-access-mode-label {
  font-weight: 600;
  color: var(--foreground);
}
.hosted-ui-access-mode-meta {
  color: var(--muted-foreground);
}

.hosted-ui-expiry-note {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}

.hosted-ui-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  align-items: center;
}

.hosted-ui-button {
  appearance: none;
  border-radius: var(--radius-control);
  padding: 0.625rem 1.125rem;
  font-size: 0.9375rem;
  font-weight: 500;
  line-height: 1.2;
  font-family: inherit;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--foreground);
  transition: background-color 150ms, border-color 150ms;
}
.hosted-ui-button:hover { background: var(--muted); }
.hosted-ui-button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.hosted-ui-button[data-variant="primary"] {
  background: var(--human);
  color: var(--human-foreground);
  border-color: transparent;
}
.hosted-ui-button[data-variant="primary"]:hover {
  filter: brightness(0.94);
}
/* The refusal. Declining is not an error and is not dressed as one — but it
 * must not read as a second primary either. Copper (--human) is reserved for
 * the owner's consent act, so Allow is the only filled control in the pair. */
.hosted-ui-button[data-variant="ghost"] {
  background: transparent;
  color: var(--muted-foreground);
  border-color: var(--border);
}
.hosted-ui-button[data-variant="ghost"]:hover {
  background: var(--muted);
  color: var(--foreground);
}
.hosted-ui-button[data-variant="danger"] {
  color: var(--destructive);
  border-color: var(--border);
}
.hosted-ui-button[data-variant="danger"]:hover {
  background: color-mix(in oklch, var(--destructive) 8%, transparent);
}

.hosted-ui-form { display: contents; }

.hosted-ui-field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.hosted-ui-field label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted-foreground);
}
.hosted-ui-field input {
  font: inherit;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--input);
  border-radius: var(--radius-control);
  background: var(--card);
  color: var(--foreground);
}
.hosted-ui-field input:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
  border-color: var(--primary);
}

.hosted-ui-code {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: 0.25em;
  color: var(--primary);
}

.hosted-ui-error {
  border: 1px solid color-mix(in oklch, var(--destructive) 25%, transparent);
  background: color-mix(in oklch, var(--destructive) 6%, transparent);
  color: var(--destructive);
  padding: 0.625rem 0.875rem;
  border-radius: var(--radius);
  font-size: 0.875rem;
}

.hosted-ui-warning {
  border: 1px solid color-mix(in oklch, var(--warning) 45%, transparent);
  background: color-mix(in oklch, var(--warning) 8%, transparent);
  color: var(--foreground);
  padding: 0.75rem 0.875rem;
  border-radius: var(--radius);
  font-size: 0.875rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.hosted-ui-warning-title {
  font-weight: 600;
  font-size: 0.8125rem;
  letter-spacing: 0.025em;
  text-transform: uppercase;
  color: var(--warning);
}
.hosted-ui-warning-body {
  color: var(--foreground);
}

.hosted-ui-result {
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
}
.hosted-ui-result-mark {
  width: 2rem;
  height: 2rem;
  border-radius: var(--radius);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.875rem;
  font-weight: 600;
  flex-shrink: 0;
}
.hosted-ui-result-mark[data-tone="success"] {
  background: color-mix(in oklch, var(--success) 14%, transparent);
  color: var(--success);
}
.hosted-ui-result-mark[data-tone="neutral"] {
  background: var(--muted);
  color: var(--muted-foreground);
}
.hosted-ui-result-mark[data-tone="danger"] {
  background: color-mix(in oklch, var(--destructive) 12%, transparent);
  color: var(--destructive);
}
.hosted-ui-result-body {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.hosted-ui-footnote {
  color: var(--muted-foreground);
  font-size: 0.75rem;
  margin-top: 0.5rem;
}

/* ─── Disclosure control ────────────────────────────────────────────────
 * The accordion's disclosure affordance used to be an ::after generated text
 * ("Choose data" / "Hide data") with no hit target of its own, sharing one
 * row with a checkbox that does something entirely different: the checkbox
 * grants the source, the disclosure only reveals its streams. On a phone one
 * tap had two plausible outcomes, and the generated text could not be
 * targeted, labelled, or sized.
 *
 * It is a real element now, with its own hit area, sitting beside the
 * checkbox rather than on top of it. */
.hosted-ui-disclosure {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  min-height: 44px;
  min-width: 44px;
  padding: 0 0.5rem;
  border: none;
  background: transparent;
  color: var(--muted-foreground);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  flex-shrink: 0;
}
.hosted-ui-disclosure:hover { color: var(--foreground); }
.hosted-ui-disclosure:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
.hosted-ui-disclosure-chevron {
  display: block;
  transition: transform 150ms;
}
.hosted-ui-option-source[open] .hosted-ui-disclosure-chevron {
  transform: rotate(90deg);
}
.hosted-ui-disclosure-label { white-space: nowrap; }

/* ─── Small screens ─────────────────────────────────────────────────────
 * There were no width breakpoints at all before this — the only two @media
 * blocks in the file were prefers-color-scheme. A consent screen is a
 * thing people reach from a phone, mid-task, from an app that just redirected
 * them. */
@media (max-width: 600px) {
  .hosted-ui-page {
    padding: 1.5rem 1rem 6.5rem;
    gap: 1.25rem;
  }

  /* Full-bleed sheets with 16px gutters: on a narrow viewport the card inset
   * costs horizontal room the stream labels need more than the border does. */
  .hosted-ui-surface {
    padding: 1rem;
  }

  /* Touch floor. Native checkboxes render ~13-16px; the label row around
   * them is what the finger actually lands on, so the floor goes there. */
  .hosted-ui-button,
  .hosted-ui-option,
  .hosted-ui-stream-option,
  .hosted-ui-access-mode-option {
    min-height: 44px;
  }
  .hosted-ui-option,
  .hosted-ui-stream-option,
  .hosted-ui-access-mode-option {
    align-items: center;
  }
  .hosted-ui-option input,
  .hosted-ui-stream-option input,
  .hosted-ui-access-mode-option input {
    width: 20px;
    height: 20px;
    margin: 0;
  }

  /* The decision pair stays reachable. Our scope list is far longer than the
   * five-row scope cards the prior-art corpus ships, so burying Allow and
   * Cancel past the end of it is the one place a sticky bar earns itself. */
  .hosted-ui-decision-actions {
    position: sticky;
    bottom: 0;
    z-index: 1;
    margin: 1.5rem -1rem 0;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border);
    background: var(--background);
  }
  .hosted-ui-decision-actions .hosted-ui-button {
    flex: 1 1 auto;
  }

  /* Bulk controls wrap instead of overflowing. */
  .hosted-ui-actions {
    gap: 0.5rem;
  }

  .hosted-ui-option-streams {
    padding-left: 1rem;
  }

  /* Two columns of a max-content label plus prose is a desktop shape. At
   * 390px it squeezes the value into a ~20ch gutter and wraps every sentence
   * to five lines. Stack the label above its value instead. */
  .hosted-ui-kv {
    grid-template-columns: 1fr;
    gap: 0.125rem;
  }
  .hosted-ui-kv dd + dt {
    margin-top: 0.625rem;
  }
}
`;

// ─── Render helpers ──────────────────────────────────────────────────────────

/**
 * Render a complete hosted HTML document. All hosted reference pages go
 * through this so they share head, CSS, and brand header.
 */
export function normalizeHostedThemeChoice(value: unknown): HostedThemeChoice {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function readHostedThemeChoiceFromCookieHeader(cookieHeader: unknown): HostedThemeChoice {
  if (typeof cookieHeader !== "string" || !cookieHeader) {
    return "system";
  }
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name !== HOSTED_UI_THEME_COOKIE_NAME) {
      continue;
    }
    const raw = part.slice(eq + 1).trim();
    try {
      return normalizeHostedThemeChoice(decodeURIComponent(raw));
    } catch {
      return normalizeHostedThemeChoice(raw);
    }
  }
  return "system";
}

export function renderHostedDocument({
  title,
  providerName,
  body,
  themeChoice = "system",
}: HostedDocumentArgs): string {
  const safeTitle = escapeHtml(title);
  const safeThemeChoice = normalizeHostedThemeChoice(themeChoice);
  return `<!DOCTYPE html>
<html lang="en" data-theme="${safeThemeChoice}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${safeTitle}</title>
<link rel="stylesheet" href="${HOSTED_UI_CSS_PATH}" />
</head>
<body ${HOSTED_UI_BRAND_MARKER}>
<main class="hosted-ui-page" aria-labelledby="hosted-ui-page-title">
${renderBrandHeader({ providerName })}
${body}
${renderBrandFooter()}
</main>
</body>
</html>`;
}

/**
 * Brand header: the instance identity, alone.
 *
 * This previously rendered a PDPP mark, the wordmark `PDPP`, a monogram
 * derived from `PDPP_INSTANCE_NAME`, and then the instance name — four marks
 * for one party, reading at screenshot scale as the unexplained token
 * "PDPP TD". Two separate errors:
 *
 *  - The monogram was unstyled (`hosted-ui-instance-monogram` appeared in the
 *    markup and never in the stylesheet), so it was bare text beside the
 *    wordmark. More basically, spec-core.md:676's monogram rule governs the
 *    CLIENT — it is a safety fallback for an app whose logo must not be
 *    fetched. Applying it to the operator inverts it: the server is the one
 *    party on this page whose identity is not in question.
 *  - Branding consent with the protocol is a category error. Consent screens
 *    are branded with the party the owner trusts and is accountable to. Here
 *    that is the instance; PDPP is the plumbing, and plumbing does not get
 *    the letterhead.
 *
 * PDPP survives as a quiet footer attribution (`renderBrandFooter`) — where
 * Plaid puts its own wordmark on a bank-branded screen.
 */
export function renderBrandHeader({ providerName }: { providerName: unknown }): string {
  const safeProvider = escapeHtml(String(providerName ?? ""));
  return `<header class="hosted-ui-header">
  <span class="hosted-ui-provider" aria-label="Provider">${safeProvider}</span>
</header>`;
}

/**
 * Quiet protocol attribution, at the foot of every hosted page. This is where
 * the PDPP mark belongs: honest about what runs the flow, without competing
 * with the instance for the header.
 */
export function renderBrandFooter(): string {
  return `<footer class="hosted-ui-footer">
  ${renderPdppMark({ size: 14 })}
  <span class="hosted-ui-footer-attribution">Secured by PDPP</span>
</footer>`;
}

/**
 * Eyebrow + heading + optional lede. The heading gets id="hosted-ui-page-title"
 * so the <main> labelled-by reference lands on something real.
 */
export function renderPageIntro({ eyebrow, title, lede }: PageIntroArgs = {}): string {
  const parts: string[] = [];
  if (eyebrow) {
    parts.push(`<span class="pdpp-eyebrow">${escapeHtml(eyebrow)}</span>`);
  }
  parts.push(`<h1 id="hosted-ui-page-title" class="pdpp-display">${escapeHtml(title ?? "")}</h1>`);
  if (lede) {
    parts.push(`<p class="pdpp-body-lg">${escapeHtml(lede)}</p>`);
  }
  return `<section class="hosted-ui-intro">${parts.join("\n")}</section>`;
}

/**
 * A semantic surface block. Use sparingly — `human` for owner/consent
 * artifacts, `protocol` for technical blocks that are genuinely protocol
 * facts, `undefined` for neutral containers.
 */
export function renderSurface({ surface, children = "", ariaLabel }: SurfaceArgs = {}): string {
  const attr = surface ? ` data-surface="${escapeHtml(surface)}"` : "";
  const label = ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : "";
  return `<section class="hosted-ui-surface"${attr}${label}>${children}</section>`;
}

/**
 * Render a <dl> of key/value facts. Values may contain markup; keys are
 * always escaped.
 */
export function renderKeyValueList(items: readonly KeyValueItem[]): string {
  const rows = items
    .filter(isRenderableKeyValueItem)
    .map((item) => {
      const dt = `<dt>${escapeHtml(item.label)}</dt>`;
      const value = item.html ? item.html : escapeHtml(String(item.value));
      const dd = `<dd>${value}</dd>`;
      return `${dt}${dd}`;
    })
    .join("");
  return `<dl class="hosted-ui-kv">${rows}</dl>`;
}

/**
 * Render a row of buttons / form submissions. Each action may specify
 * `form` (inline form with hidden fields, method and action) or `href`
 * (link styled as button).
 */
export function renderActionRow(actions: readonly Action[]): string {
  const parts = actions.map((action) => {
    if (action.href) {
      return `<a class="hosted-ui-button" data-variant="${escapeHtml(action.variant || "default")}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`;
    }
    const method = escapeHtml(action.method || "POST");
    const actionUrl = escapeHtml(action.action || "");
    const hidden = (action.hidden || [])
      .map((f) => `<input type="hidden" name="${escapeHtml(f.name)}" value="${escapeHtml(f.value ?? "")}" />`)
      .join("");
    return `<form class="hosted-ui-form" method="${method}" action="${actionUrl}">${hidden}<button type="submit" class="hosted-ui-button" data-variant="${escapeHtml(action.variant || "default")}">${escapeHtml(action.label)}</button></form>`;
  });
  return `<div class="hosted-ui-actions">${parts.join("")}</div>`;
}

/**
 * Result state — approved / denied / invalid. `tone` is success | neutral | danger.
 */
export function renderResultState({ tone = "neutral", glyph, title, body, footnote }: ResultStateArgs = {}): string {
  const defaultGlyph = { danger: "×", neutral: "•", success: "✓" }[tone] || "•";
  const safeGlyph = escapeHtml(glyph ?? defaultGlyph);
  const safeTone = escapeHtml(tone);
  const safeTitle = escapeHtml(title ?? "");
  const safeBody = body ? `<p class="pdpp-body">${escapeHtml(body)}</p>` : "";
  const safeFoot = footnote ? `<p class="hosted-ui-footnote">${escapeHtml(footnote)}</p>` : "";
  return `<div class="hosted-ui-result">
  <span class="hosted-ui-result-mark" data-tone="${safeTone}" aria-hidden="true">${safeGlyph}</span>
  <div class="hosted-ui-result-body">
    <span class="pdpp-heading">${safeTitle}</span>
    ${safeBody}
    ${safeFoot}
  </div>
</div>`;
}

/**
 * Generic empty / enter-code state for forms like `/device` without a code.
 * `form` is an object { action, method, fields: [{ name, label, value, autofocus, type }], submitLabel }.
 */
export function renderEmptyState({ title, body, form }: EmptyStateArgs = {}): string {
  const fields = (form?.fields || [])
    .map((f) => {
      const inputType = escapeHtml(f.type || "text");
      const autofocus = f.autofocus ? " autofocus" : "";
      const autocomplete = f.autocomplete ? ` autocomplete="${escapeHtml(f.autocomplete)}"` : "";
      const safeName = escapeHtml(f.name);
      const safeLabel = escapeHtml(f.label);
      const safeValue = escapeHtml(f.value ?? "");
      return `<div class="hosted-ui-field">
  <label for="hosted-ui-${safeName}">${safeLabel}</label>
  <input id="hosted-ui-${safeName}" name="${safeName}" value="${safeValue}" type="${inputType}"${autofocus}${autocomplete} />
</div>`;
    })
    .join("");

  const submitLabel = escapeHtml(form?.submitLabel || "Continue");
  const method = escapeHtml(form?.method || "GET");
  const action = escapeHtml(form?.action || "");
  const hidden = (form?.hidden || [])
    .map((f) => `<input type="hidden" name="${escapeHtml(f.name)}" value="${escapeHtml(f.value ?? "")}" />`)
    .join("");

  const bodyText = body ? `<p class="pdpp-body">${escapeHtml(body)}</p>` : "";
  const titleText = title ? `<h2 class="pdpp-heading">${escapeHtml(title)}</h2>` : "";

  return `<form class="hosted-ui-surface" method="${method}" action="${action}">
  ${titleText}
  ${bodyText}
  ${hidden}
  ${fields}
  <div class="hosted-ui-actions">
    <button type="submit" class="hosted-ui-button" data-variant="primary">${submitLabel}</button>
  </div>
</form>`;
}
