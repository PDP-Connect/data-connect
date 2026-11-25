"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";

export default function AddSourceError({ reset }: { reset: () => void }) {
  return (
    <div className="grid gap-2 py-3">
      <p className="pdpp-caption text-muted-foreground" role="alert">Couldn't load data sources. Try again.</p>
      <div><IcButton onClick={reset} size="sm" type="button" variant="ghost">Try again</IcButton></div>
    </div>
  );
}
