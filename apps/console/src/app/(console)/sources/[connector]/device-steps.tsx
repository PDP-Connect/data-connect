"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton } from "@pdpp/brand-react";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function DeviceSteps({ children, panelTargetId }: { children: ReactNode; panelTargetId?: string }) {
	const [open, setOpen] = useState(false);
	const panel = open ? <div aria-label="What to do on that computer" className="mt-3 w-full min-w-0 max-w-full rounded-md border border-border p-4" role="dialog">
		{children}
		<IcButton onClick={() => setOpen(false)} size="sm" type="button" variant="ghost">Close</IcButton>
	</div> : null;
	const target = open && panelTargetId ? document.getElementById(panelTargetId) : null;
	return (
		<div className="min-w-0 max-w-full">
			<IcButton aria-expanded={open} onClick={() => setOpen(true)} size="sm" type="button">
				See what to do on that computer
			</IcButton>
			{target ? createPortal(panel, target) : panel}
		</div>
	);
}
