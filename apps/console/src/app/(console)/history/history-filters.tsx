// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
"use client";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
export function filterHref(path: string, entries: Iterable<[string, FormDataEntryValue]>): string {
  const query=new URLSearchParams();
  for(const [key,value] of entries) if(typeof value==="string" && value)query.set(key,value);
  return `${path}${query.size ? `?${query}` : ""}`;
}
export function HistoryFilters({ path, children }: {path:string;children:ReactNode}) {
  return <form action={path} className="mb-6 flex min-w-0 flex-wrap items-center gap-4" onChange={event=>event.currentTarget.requestSubmit()}>{children}<noscript><Button type="submit">Show</Button></noscript></form>;
}
