"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useMemo } from "react";
import { RemoteAccessSetting } from "./remote-access-setting.tsx";
import { buildSettingsPractice } from "./settings-practice.ts";
export function RemoteAccessPractice({
	name,
	appVersion,
}: {
	name: string;
	appVersion: string;
}) {
	const practice = useMemo(() => buildSettingsPractice(name), [name]);
	return practice ? (
		<RemoteAccessSetting appVersion={appVersion} request={practice.request} />
	) : null;
}
