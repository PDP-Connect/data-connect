"use client";
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { requestReachability } from "./reachability-client.ts";
import { remoteAccessRowWords } from "./remote-access-summary.ts";
import { buildSettingsPractice } from "./settings-practice.ts";
import { SettingsRow } from "./settings-row.tsx";

// One line for Remote access, read once from the same route the card reads.
export function RemoteAccessRow({ practiceName }: { practiceName?: string }) {
  const [state, setState] = useState("Checking…");
  useEffect(() => {
    let active = true;
    const request = (practiceName ? buildSettingsPractice(practiceName)?.request : null) ?? requestReachability;
    void request("/state").then(
      (result) => { if (active) setState(remoteAccessRowWords(result)); },
      () => { if (active) setState("Could not check"); },
    );
    return () => { active = false; };
  }, [practiceName]);
  return <SettingsRow href="/settings/remote-access" state={state} title="Remote access" />;
}
