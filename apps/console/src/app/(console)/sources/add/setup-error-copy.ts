// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export function setupErrorCopy(code: string | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case "not-browser":
      return "This data source does not use browser setup.";
    case "not-self-service":
      return "This data source is not available for setup here.";
    default:
      return "That setup could not start. Try again.";
  }
}
