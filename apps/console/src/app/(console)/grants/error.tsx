"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";

/** Apps segment error boundary. Keep this client component free of server-only imports. */

export default function GrantsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="grid gap-3 py-8">
      <p className="text-[15px] text-foreground">Apps could not be loaded.</p>
      <IcButton onClick={reset} size="sm" type="button" variant="ghost">Try again</IcButton>
    </div>
  );
}
