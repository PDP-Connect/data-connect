"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { IcButton } from "@pdpp/brand-react";
import { useCopyAddress } from "./use-copy-address.ts";
export function CopyAddress({ address, command = false }: { address: string; command?: boolean }) {
  const { copied, error, copy } = useCopyAddress(address);
  return (
    <>
      <div className="flex min-w-0 items-center gap-3 rounded-md border border-border p-3">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all" data-command={command || undefined}>
          {address}
        </code>
        <IcButton
          aria-label={command ? (copied ? "Command copied" : "Copy command") : undefined}
          onClick={() => void copy()}
          variant="ghost"
        >
          {copied ? "Copied" : "Copy"}
        </IcButton>
      </div>
      {error ? <p role="alert">Copy did not work. Select the address and copy it.</p> : null}
    </>
  );
}
