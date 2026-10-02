// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

interface ResourceServerHttpErrorLike {
  readonly body?: unknown;
  readonly path?: unknown;
  readonly status?: unknown;
}

export function isTransientConnectorInstallCatalogError(err: unknown): boolean {
  const candidate = err as ResourceServerHttpErrorLike;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    candidate.path !== "/v1/owner/connector-install/catalog" ||
    candidate.status !== 500 ||
    typeof candidate.body !== "string"
  ) {
    return false;
  }
  return (
    candidate.body.includes("Another connector installation is in progress") ||
    candidate.body.includes("Another connector catalog refresh is in progress")
  );
}
