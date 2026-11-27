// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** The one "Technical details" link: every page that has one draws it this way. */
export const TECHNICAL_DETAILS_CLASS = "mt-6 inline-flex min-h-11 items-center text-[13px] text-muted-foreground underline underline-offset-4 hover:text-foreground";

/** A plain anchor: the technical pages are whole pages, and an anchor also renders where no router exists. */
export function TechnicalDetailsLink({ href }: { href: string }) {
  return (
    <a className={TECHNICAL_DETAILS_CLASS} href={href}>
      Technical details
    </a>
  );
}
