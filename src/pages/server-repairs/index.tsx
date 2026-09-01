// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useRef } from "react"
import { RefreshCwIcon } from "lucide-react"
import { PageContainer } from "@/components/elements/page-container"
import { Spinner } from "@/components/elements/spinner"
import { PageHeading } from "@/components/typography/page-heading"
import { Text } from "@/components/typography/text"
import { Button } from "@/components/ui/button"
import { useReferenceServer } from "@/hooks/useReferenceServer"

const LIFECYCLE_LABEL: Record<string, string> = {
  starting: "Starting the reference server…",
  "signing-in": "Signing in as owner…",
  crashed: "The reference server crashed. Restarting…",
}

export function ServerRepairs() {
  const containerRef = useRef<HTMLDivElement>(null)
  const { lifecycle, error, origin, retry } = useReferenceServer(containerRef)

  return (
    <PageContainer className="flex h-full flex-col space-y-small pb-0">
      <header className="space-y-2">
        <PageHeading>Server & Repairs</PageHeading>
        <Text as="p" intent="small" muted>
          This tab embeds the PDPP reference server's own operator UI
          directly. It is a separate application with its own styling —
          that mismatch is expected. Data stays on the server; this app does
          not copy or store anything it shows you here.
        </Text>
        {origin ? (
          <Text as="p" intent="small" muted className="font-mono">
            {origin}
          </Text>
        ) : null}
      </header>

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted/30"
      >
        {lifecycle !== "ready" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            {lifecycle === "error" ? (
              <>
                <Text as="p" intent="small">
                  {error ?? "Could not reach the reference server."}
                </Text>
                <Button size="sm" variant="outline" onClick={() => void retry()}>
                  <RefreshCwIcon className="size-4" aria-hidden />
                  Try again
                </Button>
              </>
            ) : (
              <>
                <Spinner className="size-5" />
                <Text as="p" intent="small" muted>
                  {LIFECYCLE_LABEL[lifecycle] ?? "Connecting…"}
                </Text>
              </>
            )}
          </div>
        ) : null}
      </div>
    </PageContainer>
  )
}
