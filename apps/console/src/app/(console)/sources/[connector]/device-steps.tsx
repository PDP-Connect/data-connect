"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useState, type ReactNode } from "react";

export function DeviceSteps({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div>
    <IcButton onClick={() => setOpen(true)} size="sm" type="button">See what to do on that computer</IcButton>
    {open ? <div aria-label="What to do on that computer" className="mt-3 rounded-md border border-border p-4" role="dialog">
      {children}
      <IcButton onClick={() => setOpen(false)} size="sm" type="button" variant="ghost">Close</IcButton>
    </div> : null}
  </div>;
}
