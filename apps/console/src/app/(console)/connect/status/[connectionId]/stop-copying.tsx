"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { IcButton } from "@pdpp/brand-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cancelRunAction } from "../../../syncs/[runId]/actions.ts";
import { WentWrong } from "../../../sources/add/connect-parts.tsx";
export function StopCopying({
	name,
	runId,
	preview = false,
}: {
	name: string;
	runId: string;
	preview?: boolean;
}) {
	const router = useRouter();
	const [confirming, setConfirming] = useState(false);
	const [pending, startTransition] = useTransition();
	const [message, setMessage] = useState<string | null>(null);
	function stop() {
		if (preview) {
			setConfirming(false);
			return;
		}
		startTransition(async () => {
			const result = await cancelRunAction(runId);
			if (
				!result.ok &&
				result.kind !== "already_terminal" &&
				result.kind !== "no_active_run"
			) {
				setMessage(result.message);
				return;
			}
			setConfirming(false);
			router.refresh();
		});
	}
	return (
		<div>
			{message ? (
				<>
					<p role="alert">The copy could not be stopped. Try again.</p>
					<WentWrong message={message} />
				</>
			) : null}
			{confirming ? (
				<StopCopyingQuestion
					name={name}
					onKeepGoing={() => setConfirming(false)}
					onStop={stop}
					pending={pending}
				/>
			) : (
				<button
					className="pdpp-caption min-h-11 text-muted-foreground underline"
					onClick={() => setConfirming(true)}
					type="button"
				>
					Stop
				</button>
			)}
		</div>
	);
}
export function StopCopyingQuestion({
	name,
	onKeepGoing,
	onStop,
	pending = false,
}: {
	name: string;
	onKeepGoing: () => void;
	onStop: () => void;
	pending?: boolean;
}) {
	return (
		<div
			aria-label={`Stop copying ${name}?`}
			className="grid gap-3 rounded-md border border-border p-4"
			role="alertdialog"
		>
			<p>
				Stop copying {name}? What has been copied so far is kept. You can start
				again any time.
			</p>
			<div className="flex gap-2">
				<IcButton
					disabled={pending}
					onClick={onStop}
					size="sm"
					type="button"
					variant="destructive"
				>
					{pending ? "Stopping…" : "Stop"}
				</IcButton>
				<IcButton
					disabled={pending}
					onClick={onKeepGoing}
					size="sm"
					type="button"
					variant="ghost"
				>
					Keep going
				</IcButton>
			</div>
		</div>
	);
}
