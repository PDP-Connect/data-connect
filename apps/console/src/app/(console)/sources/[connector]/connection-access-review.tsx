"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcTimestamp } from "@pdpp/brand-react";
import { Section } from "@pdpp/operator-ui/components/primitives";
import { useEffect, useRef, useState, useTransition } from "react";
import type {
  AccessAcknowledgment,
  AccessDecisionKind,
  AccessProposal,
  BindingAccessState,
} from "../../lib/binding-access-client.ts";
import { decideAccessAction, refreshAccessAction } from "./access-actions.ts";

interface Props {
  connectionId: string;
  initialState: BindingAccessState | null;
}

const CAMEL_BOUNDARY = /([a-z])([A-Z])/g;
const WORD_SEPARATOR = /[_.-]+/g;
const reviewStatus = {
  proposed: "Needs your review",
  confirmed: "Approved",
  rejected: "Declined",
  superseded: "Replaced by a newer review",
  withdrawn: "Withdrawn",
} as const;
const coverageLabel = {
  enforced: "Limits enforced",
  recorded: "Recorded only; limits are not enforced",
  not_observable: "Not verified; limits are not enforced",
} as const;

export function ConnectionAccessReview(props: Props) {
  // A refreshed server render is a new review, even if only epoch/status changed.
  return <AccessReviewSession key={`${props.connectionId}:${JSON.stringify(props.initialState)}`} {...props} />;
}
function AccessReviewSession({ connectionId, initialState }: Props) {
  const [state, setState] = useState(initialState);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [generation, setGeneration] = useState(0);
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message && !pending) {
      status.current?.focus();
    }
  }, [message, pending]);
  const proposal = state?.proposal;
  const active = state?.active;
  const refresh = async () => {
    setGeneration((value) => value + 1);
    setState(await refreshAccessAction(connectionId));
  };
  const decide = (
    target: AccessProposal,
    decision: AccessDecisionKind,
    acknowledgments: readonly AccessAcknowledgment[]
  ) => {
    if (!state) {
      return;
    }
    const input = {
      connectionId,
      proposalId: target.proposalId,
      revision: target.revision,
      baseEpoch: state.epoch,
      snapshotDigest: target.snapshotDigest,
      decision,
      ...(decision === "confirm" ? { acknowledgments: [...acknowledgments] } : {}),
    };
    startTransition(async () => {
      const result = await decideAccessAction(input);
      if (result.ok) {
        setMessage(
          {
            confirm: "Approval recorded. Use the sync controls at the top of this page when you are ready.",
            reject: "Access declined for this review.",
            withdraw: "Approval withdrawn. It cannot be used for new syncs. An active sync may continue.",
          }[decision]
        );
        await refresh();
      } else {
        setMessage(result.message);
        if (result.stale) {
          await refresh();
        }
      }
    });
  };
  return (
    <div id="access-review">
      <Section
        description="Review what this connector can access and do before you approve it."
        title="Connector access"
      >
        <div className="pdpp-caption space-y-4">
          <p className="max-w-prose text-muted-foreground">
            Approving access does not make the connector restricted. This page cannot check whether every sync on the
            server uses these approvals.
          </p>
          {message ? (
            <p ref={status} role="status" tabIndex={-1}>
              {message}
            </p>
          ) : null}
          {state ? null : <p role="alert">Access review could not be loaded. Refresh to try again.</p>}
          {state && !proposal && !active ? (
            <p>There is no access review or approval saved for this connection.</p>
          ) : null}
          {proposal ? (
            <ProposalReview
              activeId={active?.proposalId}
              epoch={state?.epoch ?? -1}
              key={`${generation}:${proposal.proposalId}:${proposal.snapshotDigest}:${state?.epoch}`}
              onDecide={decide}
              pending={pending}
              proposal={proposal}
            />
          ) : null}
          {active && active.proposalId !== proposal?.proposalId ? (
            <ProposalReview
              activeId={active.proposalId}
              epoch={state?.epoch ?? -1}
              key={`${generation}:${active.proposalId}:${active.snapshotDigest}:${state?.epoch}`}
              onDecide={decide}
              pending={pending}
              proposal={active}
            />
          ) : null}
          <IcButton
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setMessage("Review refreshed. Check the current access before deciding.");
                await refresh();
              })
            }
            size="sm"
            variant="ghost"
          >
            {pending ? "Updating access…" : "Refresh access review"}
          </IcButton>
        </div>
      </Section>
    </div>
  );
}

function ProposalReview({
  proposal,
  epoch,
  activeId,
  pending,
  onDecide,
}: {
  proposal: AccessProposal;
  epoch: number;
  activeId?: string;
  pending: boolean;
  onDecide: (
    proposal: AccessProposal,
    decision: AccessDecisionKind,
    acknowledgments: readonly AccessAcknowledgment[]
  ) => void;
}) {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [expired, setExpired] = useState(() => proposal.snapshot.expiresAt <= Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const checkExpiry = () => {
      const remaining = proposal.snapshot.expiresAt - Date.now();
      setExpired(remaining <= 0);
      if (remaining > 0) {
        timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
      }
    };
    checkExpiry();
    return () => clearTimeout(timer);
  }, [proposal.snapshot.expiresAt]);
  const acknowledgments: AccessAcknowledgment[] = proposal.snapshot.instances.flatMap((instance) =>
    instance.availability === "prepared"
      ? instance.channels.flatMap((channel) =>
          channel.coverage === "enforced"
            ? []
            : [
                {
                  instanceKey: instance.instanceKey,
                  channel: channel.name,
                  coverage: channel.coverage,
                  accessIdentity: instance.accessIdentity,
                  accessRevision: instance.accessRevision,
                },
              ]
        )
      : []
  );
  const blocked = proposal.snapshot.instances.some(
    (instance) => instance.availability !== "prepared" && instance.requestedDeclaration.required !== false
  );
  const mayConfirm = proposal.status === "proposed" && proposal.baseEpoch === epoch && !expired && !blocked;
  const allChecked = acknowledgments.every((ack) => checked.has(JSON.stringify(ack)));
  return (
    <div className="space-y-4 border-border border-t pt-4">
      <p>
        {reviewStatus[proposal.status]}
        {expired ? " · expired" : ""}
      </p>
      {proposal.snapshot.instances.map((instance) => (
        <BindingFacts instance={instance} key={instance.instanceKey} />
      ))}
      <p className="text-muted-foreground">
        Expires <IcTimestamp value={new Date(proposal.snapshot.expiresAt).toISOString()} />.
        {mayConfirm
          ? " If you approve, the approval can be reused while this access stays the same and has not expired."
          : null}
        {proposal.status === "confirmed" && activeId === proposal.proposalId && !expired
          ? " You can reuse an approval while this access stays the same and the approval has not expired."
          : null}
      </p>
      {blocked ? (
        <p role="alert">This connector needs access that the server has not provided. Approving it cannot fix that.</p>
      ) : null}
      {proposal.status === "proposed" && proposal.baseEpoch !== epoch ? (
        <p>Access has changed. Refresh this review before deciding.</p>
      ) : null}
      {expired ? <p>This review has expired. Refresh to check for a new one.</p> : null}
      {mayConfirm ? (
        <fieldset className="space-y-3" disabled={pending}>
          <legend className="font-medium">Allow each type of access that the app cannot limit</legend>
          {acknowledgments.map((ack) => {
            const key = JSON.stringify(ack);
            return (
              <label className="flex items-start gap-2" key={key}>
                <input
                  checked={checked.has(key)}
                  onChange={(event) => {
                    const next = new Set(checked);
                    if (event.target.checked) {
                      next.add(key);
                    } else {
                      next.delete(key);
                    }
                    setChecked(next);
                  }}
                  type="checkbox"
                />
                <span>
                  I allow access through {ack.instanceKey} / {ack.channel}. Data Connect cannot enforce its limits.
                </span>
              </label>
            );
          })}
          <IcButton
            disabled={!allChecked || pending}
            onClick={() => onDecide(proposal, "confirm", acknowledgments)}
            size="sm"
            type="button"
          >
            Approve access
          </IcButton>
        </fieldset>
      ) : null}
      {proposal.status === "proposed" && proposal.baseEpoch === epoch ? (
        <IcButton disabled={pending} onClick={() => onDecide(proposal, "reject", [])} size="sm" variant="ghost">
          Decline
        </IcButton>
      ) : null}
      {proposal.status === "confirmed" && activeId === proposal.proposalId ? (
        <div className="space-y-2">
          <p>Withdrawing prevents new syncs from using this approval. It does not stop a sync already running.</p>
          <IcButton disabled={pending} onClick={() => onDecide(proposal, "withdraw", [])} size="sm" variant="ghost">
            Withdraw approval
          </IcButton>
        </div>
      ) : null}
      <details>
        <summary>Technical details</summary>
        <p>
          Review {proposal.proposalId}. Policy {proposal.snapshot.policyIdentity}.
        </p>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs">
          {JSON.stringify(proposal.snapshot, null, 2)}
        </pre>
      </details>
    </div>
  );
}
function BindingFacts({ instance }: { instance: AccessProposal["snapshot"]["instances"][number] }) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium">
        {instance.instanceKey} ({instance.kind})
        {instance.availability === "prepared" ? "" : ` · ${instance.availability}`}
      </h3>
      <dl className="space-y-2 break-words">
        <div>
          <dt className="font-medium">What it can access</dt>
          <dd>
            <Facts value={instance.effectiveReach.reach ?? instance.effectiveReach} />
          </dd>
        </div>
        <div>
          <dt className="font-medium">Other access still available</dt>
          <dd>
            {instance.remainingAmbientAccess.length
              ? instance.remainingAmbientAccess.join("; ")
              : "The server has not listed other access. That does not mean there is none."}
          </dd>
        </div>
        <div>
          <dt className="font-medium">What it can do</dt>
          <dd>{instance.consequentialActions.join("; ") || "No actions described"}</dd>
        </div>
        <div>
          <dt className="font-medium">Why it needs this access</dt>
          <dd>{instance.purpose}</dd>
        </div>
        <div>
          <dt className="font-medium">Limits requested by the connector</dt>
          <dd>
            {instance.requestedDeclaration.constraints === undefined ? (
              "The connector did not request specific limits."
            ) : (
              <Facts value={instance.requestedDeclaration.constraints} />
            )}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Limits reported by the server</dt>
          <dd>
            <Facts value={instance.effectiveConstraints} />
          </dd>
        </div>
      </dl>
      <ul className="list-disc space-y-1 pl-4">
        {instance.channels.map((channel) => (
          <li key={channel.name}>
            {channel.name}: {coverageLabel[channel.coverage]}
          </li>
        ))}
      </ul>
    </div>
  );
}
function Facts({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    const entries = value.map((entry) =>
      entry !== null && typeof entry === "object" ? JSON.stringify(entry) : String(entry)
    );
    return <span>{entries.join("; ") || "Not listed by the server."}</span>;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length ? (
      <dl>
        {entries.map(([name, entry]) => (
          <div key={name}>
            <dt>{name.replace(CAMEL_BOUNDARY, "$1 $2").replace(WORD_SEPARATOR, " ")}</dt>
            <dd>
              <Facts value={entry} />
            </dd>
          </div>
        ))}
      </dl>
    ) : (
      <span>Not listed by the server.</span>
    );
  }
  return <span>{value === null || value === undefined ? "Not listed by the server." : String(value)}</span>;
}
