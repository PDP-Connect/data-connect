// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use client";

import { ConsentUnavailable } from "@/components/consent-screen/consent-screen-client.tsx";

export default function ConsentError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ConsentUnavailable kind="error" onRetry={reset} />;
}
