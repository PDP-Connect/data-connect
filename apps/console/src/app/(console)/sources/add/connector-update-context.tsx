"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, type ReactNode, useContext, useState } from "react";

interface ConnectorUpdateContextValue {
  planState: "checking" | "ready" | "failed";
  reviewRequiredIds: ReadonlySet<string>;
  setPlanState: (state: "checking" | "ready" | "failed") => void;
  setReviewRequiredIds: (ids: ReadonlySet<string>) => void;
}

const ConnectorUpdateContext = createContext<ConnectorUpdateContextValue | null>(null);

export function ConnectorUpdateProvider({ children }: { children: ReactNode }) {
  const [planState, setPlanState] = useState<"checking" | "ready" | "failed">("checking");
  const [reviewRequiredIds, setReviewRequiredIds] = useState<ReadonlySet<string>>(new Set());
  return (
    <ConnectorUpdateContext.Provider value={{ planState, reviewRequiredIds, setPlanState, setReviewRequiredIds }}>
      {children}
    </ConnectorUpdateContext.Provider>
  );
}

export function useConnectorUpdateContext(): ConnectorUpdateContextValue {
  const context = useContext(ConnectorUpdateContext);
  if (!context) {
    throw new Error("Connector update controls must share the Add source plan context.");
  }
  return context;
}
