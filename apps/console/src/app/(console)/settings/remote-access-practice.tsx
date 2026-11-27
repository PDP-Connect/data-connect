"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useMemo } from "react";
import { RemoteAccessSetting } from "./remote-access-setting.tsx";
import { buildSettingsPractice } from "./settings-practice.ts";
const skipMigration = async () => ({ adopted: 0, dropped: 0, deferred: 0, cleanup: 0, draft: "none" as const });
const openPasswordWindow = async () => ({ ok: false as const, message: "This is a practice state." });
const canOpenPasswordWindow = async () => true;
export function RemoteAccessPractice({
	name,
	appVersion,
}: {
	name: string;
	appVersion: string;
}) {
	const practice = useMemo(() => buildSettingsPractice(name), [name]);
	return practice ? (
		<RemoteAccessSetting appVersion={appVersion} request={practice.request} canOpenPasswordWindow={canOpenPasswordWindow} openPasswordWindow={openPasswordWindow} migrateReservations={skipMigration} />
	) : null;
}
