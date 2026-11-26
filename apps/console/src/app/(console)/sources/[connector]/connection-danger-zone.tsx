"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcInput } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import { WentWrong } from "../add/connect-parts.tsx";
import {
	deleteConnectionAction,
	resetAndSyncConnectionAction,
	revokeConnectionAction,
} from "./actions.ts";
import { ACTION_ERROR_COPY } from "./source-detail-copy.ts";

interface Props {
	activeRunId?: string | null;
	connectionId: string | null;
	displayName: string;
	error?: string;
	message?: string;
	setupFailed?: boolean;
  inactive?: boolean;
  neverConnected?: boolean;
	initialDialog?: "reset" | "disconnect" | "delete";
}

export const sourceRemovalCopy = {
	reset: (name: string) =>
		`Starts over and copies all of ${name} again. Your records and sign-in are kept while it runs.`,
	disconnect: (name: string) =>
		`Stops checking and signs DataConnect out of ${name}. Your records stay, and apps that can read them still can.`,
	delete: (name: string) =>
		`Erases every record from ${name} on this computer. This cannot be undone. Apps keep any copies they already took.`,
};

export function ConnectionDangerZone({
	activeRunId = null,
	connectionId,
	displayName,
	error,
	message,
	setupFailed = false,
  inactive = false,
  neverConnected = false,
	initialDialog,
}: Props) {
	return (
		<div
			className="mt-6 flex flex-col gap-5"
			data-testid="danger-zone"
			id="danger-zone"
		>
			{error ? <ActionFeedback message={error} tone="error" /> : null}
			{message ? <ActionFeedback message={message} tone="success" /> : null}
			{connectionId === null ? null : (
				<>
					{setupFailed || inactive ? null : (
						<ResetSourceForm
							connectionId={connectionId}
							displayName={displayName}
							initialOpen={initialDialog === "reset"}
						/>
					)}
					<div className="border-t border-border pt-4">
						<h3 className="pdpp-eyebrow mb-4">Remove</h3>
						<div className="flex flex-col gap-5">
							{setupFailed || inactive ? null : (
								<RevokeForm
									connectionId={connectionId}
									displayName={displayName}
									initialOpen={initialDialog === "disconnect"}
								/>
							)}
							<DeleteForm
                neverConnected={neverConnected}
								activeRunId={activeRunId}
								connectionId={connectionId}
								displayName={displayName}
								initialOpen={initialDialog === "delete"}
							/>
						</div>
					</div>
				</>
			)}
		</div>
	);
}

function ActionRow({
	label,
	sentence,
	onClick,
	children,
  open,
  destructive = false,
}: {
  open: boolean;
  destructive?: boolean;
	label: string;
	sentence: string;
	onClick: () => void;
	children?: ReactNode;
}) {
	return (
		<div>
      {!open ? <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <p className={destructive ? "pdpp-body text-destructive" : "pdpp-body"}>{label}</p>
          <p className="pdpp-body text-muted-foreground">{sentence}</p>
        </div>
        <IcButton className="shrink-0 !whitespace-normal text-left" onClick={onClick} size="sm" type="button" variant={destructive ? "destructive" : "ghost"}>{label}</IcButton>
      </div> : null}
      {children}
    </div>
	);
}

function ActionQuestion({
	label,
	sentence,
	onCancel,
	children,
}: {
	label: string;
	sentence: string;
	onCancel: () => void;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<div
			aria-describedby={`${id}-sentence`}
			aria-labelledby={`${id}-title`}
			className="grid w-full max-w-xl gap-3 rounded-md border border-border p-4"
			onKeyDown={(event) => {
				if (event.key === "Escape") onCancel();
			}}
			role="alertdialog"
			tabIndex={-1}
		>
			<h4 className="pdpp-body font-medium" id={`${id}-title`}>
				{label}?
			</h4>
			<p className="pdpp-caption text-muted-foreground" id={`${id}-sentence`}>
				{sentence}
			</p>
			{children}
		</div>
	);
}

function QuestionButtons({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  return <div className="flex flex-row-reverse justify-start gap-2">
    {children}
    <IcButton onClick={onCancel} size="sm" type="button" variant="ghost">Cancel</IcButton>
  </div>;
}

function ResetSourceForm({
	connectionId,
	displayName,
	initialOpen,
}: {
	connectionId: string;
	displayName: string;
	initialOpen: boolean;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(initialOpen);
	const [message, setMessage] = useState<{
		text: string;
		tone: "error" | "success";
	} | null>(null);
	const [isPending, startTransition] = useTransition();
	const label = "Copy everything again";
	const sentence = sourceRemovalCopy.reset(displayName);
	return (
		<ActionRow label={label} sentence={sentence} open={open} onClick={() => setOpen(true)}>
			{open ? (
				<ActionQuestion
					label={label}
					sentence={sentence}
					onCancel={() => setOpen(false)}
				>
					<QuestionButtons onCancel={() => setOpen(false)}><IcButton
						disabled={isPending}
						onClick={() => {
							setMessage(null);
							startTransition(async () => {
								const result = await resetAndSyncConnectionAction(connectionId);
								if (result.ok) {
									router.refresh();
									setOpen(false);
								}
								setMessage(
									result.ok
										? { text: "Started copying again.", tone: "success" }
										: { text: result.message, tone: "error" },
								);
							});
						}}
						size="sm"
						type="button"
						variant="ghost"
					>
						{isPending ? "Starting…" : label}
					</IcButton></QuestionButtons>
				</ActionQuestion>
			) : null}
			{message ? (
				<ActionFeedback message={message.text} tone={message.tone} />
			) : null}
		</ActionRow>
	);
}

function RevokeForm({
	connectionId,
	displayName,
	initialOpen,
}: {
	connectionId: string;
	displayName: string;
	initialOpen: boolean;
}) {
	const [open, setOpen] = useState(initialOpen);
	const label = "Disconnect and keep the records";
	const sentence = sourceRemovalCopy.disconnect(displayName);
	return (
		<ActionRow label={label} sentence={sentence} open={open} onClick={() => setOpen(true)}>
			{open ? (
				<ActionQuestion
					label={label}
					sentence={sentence}
					onCancel={() => setOpen(false)}
				>
					<form action={revokeConnectionAction}>
						<input name="connection_id" type="hidden" value={connectionId} />
						<input name="confirm_revoke" type="hidden" value="yes" />
						<QuestionButtons onCancel={() => setOpen(false)}><IcButton size="sm" type="submit" variant="ghost">
							{label}
						</IcButton></QuestionButtons>
					</form>
				</ActionQuestion>
			) : null}
		</ActionRow>
	);
}

function DeleteForm({
  neverConnected,
	activeRunId,
	connectionId,
	displayName,
	initialOpen,
}: {
	neverConnected: boolean;
  activeRunId: string | null;
	connectionId: string;
	displayName: string;
	initialOpen: boolean;
}) {
	const [open, setOpen] = useState(initialOpen);
	const [typed, setTyped] = useState("");
	const confirmed = neverConnected || typed === displayName;
	const label = neverConnected ? `Remove ${displayName}` : "Delete and erase the records";
	const sentence = neverConnected ? `Takes ${displayName} off your list. There is nothing to erase.` : sourceRemovalCopy.delete(displayName);
	const close = () => {
		setOpen(false);
		setTyped("");
	};
	return (
		<ActionRow label={label} sentence={sentence} open={open} destructive={!neverConnected} onClick={() => setOpen(true)}>
			{open ? (
				<ActionQuestion label={label} sentence={sentence} onCancel={close}>
					<form action={deleteConnectionAction} className="grid gap-3">
						<input name="connection_id" type="hidden" value={connectionId} />
						{activeRunId ? (
							<input name="cancel_run_id" type="hidden" value={activeRunId} />
						) : null}
						<input
							name="confirm_delete"
							type="hidden"
							value={confirmed ? connectionId : ""}
						/>
						{!neverConnected ? <label
							className="pdpp-caption flex flex-col gap-1 text-muted-foreground"
							htmlFor="confirm-delete-input"
						>
							<span>Type {displayName} to confirm.</span>
							<IcInput
								aria-label="Type the data source name to confirm deletion"
								autoComplete="off"
								className="w-full max-w-md"
								id="confirm-delete-input"
								onChange={(event) => setTyped(event.target.value)}
								value={typed}
							/>
						</label> : null}
						<QuestionButtons onCancel={close}><IcButton
							disabled={!confirmed}
							size="sm"
							type="submit"
							variant="destructive"
						>
							{activeRunId ? "Stop the sync and delete" : label}
						</IcButton></QuestionButtons>
					</form>
				</ActionQuestion>
			) : null}
		</ActionRow>
	);
}

function ActionFeedback({
	message,
	tone,
}: {
	message: string;
	tone: "error" | "success";
}) {
	return tone === "error" ? (
		<div className="text-sm" role="alert">
			<p className="text-destructive">{ACTION_ERROR_COPY}</p>
			<WentWrong message={message} />
		</div>
	) : (
		<p
			aria-live="polite"
			className="text-sm text-muted-foreground"
			role="status"
		>
			{message}
		</p>
	);
}
