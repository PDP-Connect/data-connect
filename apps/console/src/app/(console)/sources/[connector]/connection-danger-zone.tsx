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
					{setupFailed ? null : (
						<ResetSourceForm
							connectionId={connectionId}
							displayName={displayName}
							initialOpen={initialDialog === "reset"}
						/>
					)}
					<div className="border-t border-border pt-4">
						<h3 className="pdpp-eyebrow mb-4">Remove</h3>
						<div className="flex flex-col gap-5">
							{setupFailed ? null : (
								<RevokeForm
									connectionId={connectionId}
									displayName={displayName}
									initialOpen={initialDialog === "disconnect"}
								/>
							)}
							<DeleteForm
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
}: {
	label: string;
	sentence: string;
	onClick: () => void;
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-start gap-2">
			<IcButton
				className="text-destructive"
				onClick={onClick}
				size="sm"
				type="button"
				variant="ghost"
			>
				{label}
			</IcButton>
			<p className="pdpp-caption text-muted-foreground">{sentence}</p>
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
			className="grid w-full gap-3 rounded-md border border-border p-4"
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
			<IcButton
				autoFocus
				onClick={onCancel}
				size="sm"
				type="button"
				variant="ghost"
			>
				Cancel
			</IcButton>
		</div>
	);
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
		<ActionRow label={label} sentence={sentence} onClick={() => setOpen(true)}>
			{open ? (
				<ActionQuestion
					label={label}
					sentence={sentence}
					onCancel={() => setOpen(false)}
				>
					<IcButton
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
						variant="destructive"
					>
						{isPending ? "Starting…" : label}
					</IcButton>
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
		<ActionRow label={label} sentence={sentence} onClick={() => setOpen(true)}>
			{open ? (
				<ActionQuestion
					label={label}
					sentence={sentence}
					onCancel={() => setOpen(false)}
				>
					<form action={revokeConnectionAction}>
						<input name="connection_id" type="hidden" value={connectionId} />
						<input name="confirm_revoke" type="hidden" value="yes" />
						<IcButton size="sm" type="submit" variant="destructive">
							{label}
						</IcButton>
					</form>
				</ActionQuestion>
			) : null}
		</ActionRow>
	);
}

function DeleteForm({
	activeRunId,
	connectionId,
	displayName,
	initialOpen,
}: {
	activeRunId: string | null;
	connectionId: string;
	displayName: string;
	initialOpen: boolean;
}) {
	const [open, setOpen] = useState(initialOpen);
	const [typed, setTyped] = useState("");
	const confirmed = typed === displayName;
	const label = "Delete and erase the records";
	const sentence = sourceRemovalCopy.delete(displayName);
	const close = () => {
		setOpen(false);
		setTyped("");
	};
	return (
		<ActionRow label={label} sentence={sentence} onClick={() => setOpen(true)}>
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
						<label
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
						</label>
						<IcButton
							disabled={!confirmed}
							size="sm"
							type="submit"
							variant="destructive"
						>
							{activeRunId ? "Stop the sync and delete" : label}
						</IcButton>
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
