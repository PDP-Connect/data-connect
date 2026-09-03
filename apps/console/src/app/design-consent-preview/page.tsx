// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * /design-consent-preview — owner-only preview of the anticipated consent
 * screen, built from the real @pdpp/brand-react components (Sheet,
 * HumanSurface, IcButton, ConnectorIcon, ...) so it renders on the SAME
 * component modules as /sources and /explore — zero drift by construction.
 *
 * Unlike /design-system (a deliberately ungated top-level route, see that
 * page's own docstring), this route calls the console's real DAL gate
 * (`verifyDashboardSession`) directly, the same authoritative owner-session
 * check every page under the `(console)` route group uses. It lives OUTSIDE
 * `(console)` on purpose — a standalone human surface, not wrapped in the
 * console's sidebar shell — but inherits the root layout's fonts and
 * globals.css exactly like /design-system does, so typefaces and the full
 * token/component cascade (@pdpp/brand/styles.css -> ink-carbon.css ->
 * @pdpp/brand-react/components.css -> @pdpp/brand-react/shell.css) match
 * the console pages exactly.
 *
 * Submits nothing: no form, no POST target, no mutating handler. Allow and
 * Cancel are inert buttons. Reads no owner data — every source, stream, and
 * account label is a literal in mock-data.ts.
 *
 * Variants: ?width=mobile, ?trust=unverified|domain|verified,
 * ?state=signin|deny|error|receipt — same params the reference-server round
 * of this mock used (commit 4dbe7fa9f), so the owner's earlier feedback
 * stays comparable against this rebuild.
 */
import type { Metadata } from "next";
import { verifyDashboardSession } from "@/app/(console)/lib/verify-session.ts";
import { ConsentPreviewClient, type PreviewState, type TrustTier } from "./consent-preview-client.tsx";
import { clientLogoSvg, sourceIcon } from "./icons.ts";
import { SOURCE_ICON_FILES } from "./mock-data.ts";

export const metadata: Metadata = {
  robots: { follow: false, index: false, nocache: true },
};

// Default is "domain", not "unverified": a real ChatGPT publishes its client
// metadata document at chatgpt.com, so the automatic domain-verification
// check this mock's CLIENT scenario represents would actually succeed. The
// unverified tier is real and stays reachable at ?trust=unverified, but it
// must not be what the owner sees first for an example built around a client
// that would, in practice, verify.
function parseTrust(value: string | string[] | undefined): TrustTier {
  return value === "unverified" || value === "verified" ? value : "domain";
}

function parseState(value: string | string[] | undefined): PreviewState {
  return value === "signin" || value === "deny" || value === "error" || value === "receipt" ? value : "consent";
}

export default async function DesignConsentPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await verifyDashboardSession("/design-consent-preview");

  const params = await searchParams;
  const trust = parseTrust(params.trust);
  const state = parseState(params.state);
  const forceMobile = params.width === "mobile";

  const sourceLogos: Record<string, string> = {};
  for (const sourceId of Object.keys(SOURCE_ICON_FILES)) {
    const icon = sourceIcon(sourceId);
    if (icon) sourceLogos[sourceId] = icon.svg;
  }

  return (
    <ConsentPreviewClient
      forceMobile={forceMobile}
      logos={{ client: clientLogoSvg(), sources: sourceLogos }}
      state={state}
      trust={trust}
    />
  );
}
