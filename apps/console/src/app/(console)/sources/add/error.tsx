"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { ADD_SOURCE_COPY } from "./add-source-list-model.ts";

export default function AddSourceError({ reset }: { reset: () => void }) {
  return (
    <div className="grid gap-2 py-3">
      <p className="pdpp-caption text-muted-foreground" role="alert">{ADD_SOURCE_COPY.loadFailed}</p>
      <div><IcButton onClick={reset} size="sm" type="button" variant="ghost">{ADD_SOURCE_COPY.retry}</IcButton></div>
    </div>
  );
}
