// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	buttonVariants,
	IcButton,
	type ConnectorIconLike,
} from "@pdpp/brand-react";
import { DataList } from "@pdpp/operator-ui/components/primitives";
import Link from "next/link";
import type { ReactNode } from "react";
import {
	ConnectHeader,
	ConnectWorkingMark,
	WentWrong,
} from "../../../sources/add/connect-parts.tsx";
import { sourceDetailHref } from "./connect-status-links.ts";
import {
	type FirstSyncOutcome,
	headlineFor,
	type OutcomeLink,
} from "./first-sync-outcome.ts";

function LinkButton({
	link,
	primary,
}: {
	link: OutcomeLink;
	primary: boolean;
}) {
	return (
		<Link
			className={buttonVariants({
				className: "min-h-11",
				size: "sm",
				variant: primary ? "default" : "ghost",
			})}
			href={link.href}
		>
			{link.label}
		</Link>
	);
}

function recordsLine(count: number): string {
	return `${new Intl.NumberFormat("en-US").format(count)} ${count === 1 ? "record" : "records"}`;
}

/** What arrived, in the list style of "What is here" on a data source's page. */
function ArrivedList({
	collected,
	connectionId,
}: {
	collected: Extract<FirstSyncOutcome, { kind: "worked" }>["collected"];
	connectionId: string;
}) {
	if (collected.length === 0) return null;
	return (
		<div data-testid="collected-kinds">
			<DataList ariaLabel="What arrived">
				{collected.map((kind) => (
					<li key={kind.stream}>
						<Link
							className="flex flex-col gap-1 px-3 py-3 transition-colors hover:bg-muted/40"
							href={`/sources/${encodeURIComponent(connectionId)}/${encodeURIComponent(kind.stream)}`}
						>
							<span className="text-foreground">{kind.label}</span>
							<span className="pdpp-caption tabular-nums text-muted-foreground">
								{recordsLine(kind.count)}
							</span>
						</Link>
					</li>
				))}
			</DataList>
		</div>
	);
}

import { StopCopying } from "./stop-copying.tsx";

function Body({
	name,
	preview = false,
	connectionId,
	outcome,
	resumeAction,
}: {
	name: string;
	preview?: boolean;
	connectionId: string;
	outcome: FirstSyncOutcome;
	resumeAction: (formData: FormData) => void | Promise<void>;
}): ReactNode {
	switch (outcome.kind) {
		case "worked":
			return (
				<>
					<ArrivedList
						collected={outcome.collected}
						connectionId={connectionId}
					/>
					{outcome.schedule ? (
						<p className="text-muted-foreground">{outcome.schedule}</p>
					) : null}
					<div className="flex flex-wrap gap-2">
						<LinkButton link={outcome.primary} primary />
						<LinkButton link={outcome.secondary} primary={false} />
					</div>
				</>
			);
		case "empty":
			return <LinkButton link={outcome.retry} primary />;
		case "running":
			return (
				<>
					<p className="text-muted-foreground">
						{outcome.signedIn ? "You're signed in. " : ""}This can take a few
						minutes, or hours for a large account. You can close this page.
						DataConnect keeps going.
					</p>
					<ConnectWorkingMark label="Copying" />
					<div className="flex flex-wrap gap-2">
						<LinkButton link={outcome.addAnother} primary={false} />
					</div>
					{outcome.runId ? (
						<StopCopying name={name} preview={preview} runId={outcome.runId} />
					) : null}
				</>
			);
		case "partial":
			return (
				<>
					<ArrivedList
						collected={outcome.collected}
						connectionId={connectionId}
					/>
					<h2 className="pdpp-eyebrow">Didn't come</h2>
					<DataList ariaLabel="Didn't come">
						{outcome.missing.map((gap) => (
							<li className="flex flex-col gap-1 px-3 py-3" key={gap.label}>
								<p className="text-foreground">{gap.label}</p>
								<p className="pdpp-caption text-muted-foreground">
									{gap.message}
									{gap.retryNote ? ` ${gap.retryNote}` : ""}
								</p>
							</li>
						))}
					</DataList>
					<div className="flex flex-wrap gap-2">
						{outcome.retry?.label === "Sign in again" ? (
							<>
								<LinkButton link={outcome.retry} primary />
								<LinkButton link={outcome.primary} primary={false} />
							</>
						) : (
							<>
								<LinkButton link={outcome.primary} primary />
								{outcome.retry ? (
									<LinkButton link={outcome.retry} primary={false} />
								) : null}
							</>
						)}
					</div>
					{outcome.technical ? (
						<Link
							className="pdpp-caption text-muted-foreground underline"
							href={outcome.technical.href}
						>
							{outcome.technical.label}
						</Link>
					) : null}
				</>
			);
		case "needs-you":
			return <LinkButton link={outcome.next} primary />;
		case "failed":
			return (
				<>
					{outcome.reason ? (
						<p className="text-muted-foreground">{outcome.reason}</p>
					) : null}
					<div className="flex flex-wrap gap-2">
						<LinkButton link={outcome.retry} primary />
						{outcome.secondary ? (
							<LinkButton link={outcome.secondary} primary={false} />
						) : null}
					</div>
					{outcome.wentWrong ? <WentWrong message={outcome.wentWrong} /> : null}
					{outcome.technical ? (
						<Link
							className="pdpp-caption text-muted-foreground underline"
							href={outcome.technical.href}
						>
							{outcome.technical.label}
						</Link>
					) : null}
				</>
			);
		case "paused":
			// The same Resume action the Data sources list offers for a paused data source.
			return (
				<div className="flex flex-wrap gap-2">
					<form action={resumeAction}>
						<input name="connection_id" type="hidden" value={connectionId} />
						<IcButton
							className="min-h-11"
							size="sm"
							type="submit"
							variant="default"
						>
							Resume
						</IcButton>
					</form>
					<LinkButton link={outcome.open} primary={false} />
				</div>
			);
		case "revoked":
			return <LinkButton link={outcome.addAnother} primary />;
	}
}

/** Page 3 body: the outcome as the heading, what arrived, the schedule, at most two buttons. */
export function FirstSyncBody({
	connectionId,
	connectorId,
	icon,
	name,
	outcome,
	resumeAction,
	preview = false,
}: {
	preview?: boolean;
	connectionId: string;
	connectorId: string;
	icon?: ConnectorIconLike | null;
	name: string;
	outcome: FirstSyncOutcome;
	resumeAction: (formData: FormData) => void | Promise<void>;
}) {
	return (
		<div className="[&>header]:mb-0" data-testid={`first-sync-${outcome.kind}`}>
			<ConnectHeader
				connectorKey={connectorId}
				icon={icon}
				lastCrumb={{
					href: sourceDetailHref({ connection_id: connectionId, connector_id: connectorId, setup_kind: "", status: "" }),
					label: name,
				}}
				name={name}
				title={headlineFor(outcome, name)}
                step={outcome.kind === "running" && outcome.signIn ? "Step 2 of 2: copy your data" : undefined}
			/>
			<div className="grid max-w-xl gap-4 pb-4">
				<Body
					connectionId={connectionId}
					name={name}
					outcome={outcome}
					preview={preview}
					resumeAction={resumeAction}
				/>
			</div>
		</div>
	);
}
