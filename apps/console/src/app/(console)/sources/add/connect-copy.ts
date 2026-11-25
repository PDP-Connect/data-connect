// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Words on the "Connect <Name>" pages (design "Page 2"). Kept in one file so
 * the design file and the screen can be compared line by line.
 */

export const connectHeading = (name: string): string => `Connect ${name}`;

export const gettingReadyCopy = {
  heading: (name: string) => `Getting ${name} ready…`,
  failed: (name: string) => `${name} couldn't be set up. Check that this computer is online, then try again.`,
  retry: "Try again",
  whatWentWrong: "What went wrong",
  wait: "This can take a minute.",
} as const;

export const signInCopy = {
  lead: (name: string) =>
    `DataConnect signs in to ${name} for you, in a browser you can watch. If ${name} asks for a code, you type it there.`,
  storage: (name: string) =>
    `Your password is stored encrypted on the computer that runs DataConnect. It is sent only to ${name}.`,
  saveSignIn: "Save my sign-in so DataConnect can sign in again without me",
  button: connectHeading,
} as const;

export const keyCopy = {
  lead: (name: string) => `${name} gives you a key that lets DataConnect read your data.`,
  whereToFind: "Where to find it",
  storage: (name: string) =>
    `Your key is stored encrypted on the computer that runs DataConnect. It is sent only to ${name}.`,
  storageNotReady: "This server is not set up to store keys yet.",
  button: connectHeading,
} as const;

export const fileCopy = {
  lead: (name: string) => `${name} has no sign-in. You export a file from it and give the file to DataConnect.`,
  exportStep: "Export your data",
  chooseStep: "Choose the file",
  button: "Import",
  checkFirst: "Check the file first",
  addTo: (existingName: string) => `Add to ${existingName}`,
  separate: "Keep as a separate data source",
} as const;

export const programCopy = {
  lead: "This one runs on the computer that has the data.",
  waiting: "Waiting for it to check in…",
  checkedIn: (name: string) => `${name} checked in.`,
  seeData: "See your data",
  startStep: "Then start collecting:",
} as const;

export const cannotAddCopy = {
  heading: (name: string) => `${name} can't be added here yet.`,
  back: "Back to all services",
} as const;

export const accountCopy = {
  nameLabel: "Name for this account",
  /** e.g. "Amazon, work" */
  namePlaceholder: (name: string) => `${name}, work`,
  already: "You already have",
  addsAnother: "This adds another account.",
} as const;

export function newServiceNote(name: string): string {
  return `${name} is new here. It works in our tests, but it has not been tried with many accounts yet.`;
}

/** True for the tiers the design calls new: development and preview. */
export function isNewService(tier: string | null | undefined): boolean {
  return tier === "development" || tier === "preview";
}

/** "Accepted: .zip, .xml, up to 8 GB each." */
export function acceptedFilesLine(extensions: readonly string[], names: readonly string[], maxBytes: number | null | undefined): string {
  const accepted = [...names, ...extensions].join(", ");
  const size = maxBytes ? `, up to ${formatBytes(maxBytes)} each` : "";
  return `Accepted: ${accepted || "the file the service exports"}${size}.`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    unit = next;
    if (value < 1024 || next === "GB") break;
    value /= 1024;
  }
  const rounded = value >= 10 || unit === "B" ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${unit}`;
}
