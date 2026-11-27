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
  storageNotReady: (name: string) => `This server can't store keys yet, so ${name} can't be connected.`,
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
  terminal: "Open a terminal on that computer, paste this command and press Enter.",
  needsNode: "It needs Node.js.",
  waiting: "Waiting for it to check in…",
  checkedIn: (name: string) => `${name} checked in.`,
  seeData: "See your data",
  startStep: "Then start collecting:",
} as const;

export const cannotAddCopy = {
  heading: (name: string) => `${name} can't be added here yet.`,
  back: "Back to all services",
} as const;

/** The name a sentence uses: the catalog's qualifier "(browser session)" tells two entries apart and has no place in prose. */
export function sentenceName(name: string): string {
  return name.replace(/\s*\(browser session\)\s*$/i, "");
}

/** Why a sign-in service cannot be added on this computer, and what to do instead. `reason` is the server's readiness reason. */
export function cannotAddWhy(fullName: string, reason: string | null): { reason: string | null; instead: string; undecided: boolean } {
  const name = sentenceName(fullName);
  const pickAnother = "Pick another service from the list.";
  switch (reason) {
    case "host_requirement_unmet":
      return { reason: `This computer can't open the browser that ${name} needs for signing in.`, instead: `Add ${name} from DataConnect on a computer that can open a browser. ${pickAnother}`, undecided: false };
    case "not_published":
      return { reason: `${name} has not been published for DataConnect yet.`, instead: `Check again after DataConnect updates. ${pickAnother}`, undecided: false };
    case "catalog_unavailable":
    case "inspection_unavailable":
    case "artifact_invalid":
      return { reason: `DataConnect couldn't check whether ${name} can run on this computer.`, instead: "Try again in a few minutes.", undecided: true };
    case "not_implemented":
      return { reason: `DataConnect can't collect from ${name} yet.`, instead: `Check again after DataConnect updates. ${pickAnother}`, undecided: false };
    default:
      // An unknown reason still gets a neutral explanation and a way to retry.
      return { reason: `DataConnect couldn't tell whether ${name} can be set up on this computer.`, instead: "Try again in a few minutes.", undecided: true };
  }
}

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
