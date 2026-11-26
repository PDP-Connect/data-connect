"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { AppConfig } from "../lib/app-config-client.ts";
import { DesktopSettingsSetting } from "./desktop-settings-setting.tsx";
const config: AppConfig = { storageProvider: null, serverMode: null, selfHostedUrl: null, startMinimized: false, closeToTray: true };
const loadAppConfig = async () => config;
const loadAutostart = async () => ({ enabled: false, error: null, known: true });
const setAutostart = async () => ({ ok: false as const, message: "This is a practice state." });
const saveAppConfigField = async () => ({ ok: false as const, message: "This is a practice state." });
export function DesktopSettingsPractice() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } }));
  return <QueryClientProvider client={client}><DesktopSettingsSetting loadAppConfig={loadAppConfig} loadAutostart={loadAutostart} saveAppConfigField={saveAppConfigField} setAutostart={setAutostart} /></QueryClientProvider>;
}
