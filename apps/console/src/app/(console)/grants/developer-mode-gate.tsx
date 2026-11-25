"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { getDeveloperModeServerSnapshot, getDeveloperModeSnapshot, subscribeToDeveloperMode } from "../lib/source-setup-development.ts";

function useDeveloperMode(): boolean {
  return useSyncExternalStore(subscribeToDeveloperMode, getDeveloperModeSnapshot, getDeveloperModeServerSnapshot);
}

export function DeveloperModeGate({ children }: { children: ReactNode }) {
  const enabled = useDeveloperMode();
  if (enabled) return children;
  return (
    <p className="text-[13px] text-muted-foreground">
      This page is for developers. Turn on <Link className="text-primary underline-offset-2 hover:underline" href="/settings#developer-mode">Developer mode</Link> to open it.
    </p>
  );
}

export function DeveloperModeRequestLink() {
  const enabled = useDeveloperMode();
  if (!enabled) return null;
  return <Link className="text-[13px] text-primary underline-offset-2 hover:underline" href="/grants/request">Developer request tool</Link>;
}
