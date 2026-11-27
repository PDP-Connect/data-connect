// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import Link from "next/link";
import { RecordroomShellWithPalette } from "./components/recordroom-shell-with-palette.tsx";

/**
 * Console not-found page (App Router convention). Any page in the console
 * that calls `notFound()` renders this inside the shared frame, so the menu
 * stays and the person has one way back. Addresses that match no route at
 * all, and pages outside the console group (for example `/consent`), use the
 * root not-found instead.
 */
export default function ConsoleNotFound() {
  return (
    <RecordroomShellWithPalette>
      <div className="flex max-w-xl flex-col items-start gap-4 py-16">
        <h1 className="pdpp-heading text-foreground">This page does not exist.</h1>
        <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/">
          Go to Home
        </Link>
      </div>
    </RecordroomShellWithPalette>
  );
}
