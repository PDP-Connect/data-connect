// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants } from "@pdpp/brand-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { ConnectorIconLike } from "@pdpp/brand-react";
import { ConnectorMark } from "../../../components/connector-mark.tsx";
import { WentWrong } from "../../../sources/add/connect-parts.tsx";
import { type FirstSyncOutcome, headlineFor, type OutcomeLink } from "./first-sync-outcome.ts";

function LinkButton({ link, primary }: { link: OutcomeLink; primary: boolean }) {
  return (
    <Link
      className={buttonVariants({ className: "min-h-11", size: "sm", variant: primary ? "default" : "ghost" })}
      href={link.href}
    >
      {link.label}
    </Link>
  );
}

function Details({ outcome }: { outcome: FirstSyncOutcome }): ReactNode {
  switch (outcome.kind) {
    case "worked":
      return (
        <>
          {outcome.collected.length > 0 ? (
            <dl className="grid max-w-md gap-1" data-testid="collected-kinds">
              {outcome.collected.map((kind) => (
                <div className="flex justify-between gap-4" key={kind.label}>
                  <dt className="text-foreground">{kind.label}</dt>
                  <dd className="text-muted-foreground">{new Intl.NumberFormat("en-US").format(kind.count)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {outcome.schedule ? <p className="pdpp-caption text-muted-foreground">{outcome.schedule}</p> : null}
          <div className="flex flex-wrap gap-2">
            <LinkButton link={outcome.primary} primary />
            <LinkButton link={outcome.secondary} primary={false} />
          </div>
        </>
      );
    case "empty":
      return <LinkButton link={outcome.retry} primary />;
    case "running":
      return <LinkButton link={outcome.watch} primary={false} />;
    case "needs-you":
      return <LinkButton link={outcome.next} primary />;
    case "failed":
      return (
        <>
          <p className="text-muted-foreground">{outcome.reason}</p>
          <div>
            <LinkButton link={outcome.retry} primary />
          </div>
          {outcome.wentWrong ? <WentWrong message={outcome.wentWrong} /> : null}
        </>
      );
    case "paused":
      return <LinkButton link={outcome.open} primary={false} />;
    case "revoked":
      return <LinkButton link={outcome.addAnother} primary />;
  }
}

/** Page 3 body: one sentence for the outcome, what arrived, the right next button. */
export function FirstSyncBody({
  connectorId,
  icon,
  name,
  outcome,
}: {
  connectorId: string;
  icon?: ConnectorIconLike | null;
  name: string;
  outcome: FirstSyncOutcome;
}) {
  return (
    <div className="grid max-w-2xl gap-4" data-testid={`first-sync-${outcome.kind}`}>
      <h1 className="pdpp-section-title inline-flex items-center gap-2">
        <ConnectorMark connectorId={connectorId} icon={icon} name={name} />
        {headlineFor(outcome, name)}
      </h1>
      <Details outcome={outcome} />
    </div>
  );
}
