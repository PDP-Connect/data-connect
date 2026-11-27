"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import { useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * The one submit button of a connect form. It disables itself and says it is busy once pressed,
 * for a server action (form status) and for a plain POST (the press itself), so a second press
 * cannot start a second sign-in.
 */
export function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  const [pressed, setPressed] = useState(false);
  const busy = pending || pressed;
  return (
    <button
      aria-busy={busy || undefined}
      className={buttonVariants({ className: "min-h-11", size: "lg", variant: "default" })}
      disabled={busy}
      onClick={() => setTimeout(() => setPressed(true), 0)}
      type="submit"
    >
      {children}
    </button>
  );
}
