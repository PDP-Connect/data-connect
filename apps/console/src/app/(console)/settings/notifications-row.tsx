"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { SettingsRow } from "./settings-row.tsx";
export function NotificationsRow({ practice = false }: { practice?: boolean }) {
  const [state, setState] = useState("Checking this browser…");
  useEffect(() => {
    if (practice) { setState("Off"); return; }
    let active = true;
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("Not available in this browser"); return;
    }
    void navigator.serviceWorker.getRegistration().then(async registration => {
      const subscription = await registration?.pushManager.getSubscription();
      if (active) setState(subscription && Notification.permission === "granted" ? "On for this browser" : "Off");
    }).catch(() => { if (active) setState("Could not check this browser"); });
    return () => { active = false; };
  }, [practice]);
  return <SettingsRow href="/notifications" state={state} title="Notifications" />;
}
