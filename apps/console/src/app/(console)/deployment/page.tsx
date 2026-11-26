// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { extractReadinessInputs } from "../components/deployment-readiness-rows.ts";
import { getDeploymentDiagnostics, type DeploymentDiagnostics } from "../lib/ref-client.ts";
import { ServerChecks } from "./server-checks.tsx";
import { SupportCopy } from "../components/support-copy.tsx";
import { buildServerPractice } from "./plain-checks.ts";

export const dynamic = "force-dynamic";

interface DeploymentPageParams {
  demo?: string;
  error?: string;
  notice?: string;
}

// Operator-facing diagnostics for the reference deployment. Not a PDPP
// protocol surface — this page consumes /_ref/deployment and renders the
// report the RS already redacted. The goal is "why isn't retrieval working"
// answered in one glance, without the operator reading logs or SSHing in.
//
// Spec: openspec/changes/make-semantic-retrieval-operational/
//       specs/reference-implementation-architecture/spec.md
export default async function DeploymentPage({ searchParams }: { searchParams: Promise<DeploymentPageParams> }) {
  const params = await searchParams;
  const practice = process.env.NODE_ENV !== "production" && params.demo ? buildServerPractice(params.demo) : null;
  if (practice) return <RecordroomShellWithPalette><main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6"><PageHeader title="Server" /><ServerChecks inputs={practice.inputs} practice={practice} /><Link href="/deployment/technical">Technical details</Link></main></RecordroomShellWithPalette>;
  let report: DeploymentDiagnostics | null = null;
  let unreachable = false;
  let loadError = "Server checks could not be loaded";
  try {
    report = await getDeploymentDiagnostics();
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      unreachable = true;
      loadError = err.message;
    } else {
      throw err;
    }
  }

  if (unreachable || !report) {
    return (
      <RecordroomShellWithPalette>
        <main className="mx-auto grid max-w-5xl gap-4 px-4 py-6"><PageHeader title="Server" /><p>This could not be loaded. <Link href="/deployment">Try again</Link>.</p><SupportCopy details={loadError} /></main>
      </RecordroomShellWithPalette>
    );
  }

  return (
    <RecordroomShellWithPalette>
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6">
        <PageHeader title="Server" />
        {params.error ? <div role="status"><p>This could not be completed. Try again from Technical details.</p><SupportCopy details={params.error} /></div> : null}
        {params.notice === "dataset_summary_rebuilt" ? <p role="status">The stored data list was rebuilt.</p> : null}
        <ServerChecks desktop={process.env.PDPP_MANAGED_DESKTOP_HOST === "1"} inputs={extractReadinessInputs(report)} />
        <nav aria-label="Server settings" className="grid border-y border-border/70 sm:grid-cols-2">
          <Link className="flex min-h-11 items-center border-b border-border/70 py-3 text-[15px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:border-b-0 sm:border-r sm:pr-4" href="/deployment/provider-apps">
            Sign-in apps for data sources
          </Link>
          <Link className="flex min-h-11 items-center py-3 text-[15px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pl-4" href="/deployment/tokens">
            Tokens for scripts and tools
          </Link>
        </nav>
        <Link className="min-h-11 py-3 text-sm underline" href="/deployment/technical">Technical details</Link>

      </main>
    </RecordroomShellWithPalette>
  );
}
