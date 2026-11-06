// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RunUploadAuthority, RunUploadGrant } from "../server/stores/run-upload-permission-store.ts";

export type RunUploadFacts = Pick<
  RunUploadGrant,
  "connectionId" | "connectorId" | "ownerId" | "runId" | "manifestSnapshot" | "sourceSnapshot"
> & { readonly selection: NonNullable<RunUploadGrant["staging"]>["selection"] };

/** One run owns this handle, including an issue that has not returned yet.
 * A rejected close stays rejected: callers must retain their flight fence.
 */
export class RunUploadLifetime {
  private state: "pending" | "issued" | "closed" = "pending";
  private issuing: Promise<RunUploadAuthority> | undefined;
  private closing: Promise<void> | undefined;

  private readonly issueGrant: (facts: RunUploadFacts) => Promise<RunUploadAuthority>;
  private readonly revokeGrant: (grant: RunUploadGrant) => Promise<void>;

  constructor(
    issueGrant: (facts: RunUploadFacts) => Promise<RunUploadAuthority>,
    revokeGrant: (grant: RunUploadGrant) => Promise<void>
  ) {
    this.issueGrant = issueGrant;
    this.revokeGrant = revokeGrant;
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }

  async issue(input: RunUploadFacts): Promise<string> {
    if (this.state !== "pending" || this.issuing) {
      throw new Error("Run upload lifetime is not pending");
    }
    const facts = structuredClone(input);
    this.issuing = this.issueGrant(facts);
    const authority = await this.issuing;
    if (this.isClosed()) {
      await this.close();
      throw new Error("Run upload lifetime closed during issuance");
    }
    this.state = "issued";
    return authority.token;
  }

  close(): Promise<void> {
    this.state = "closed";
    this.closing ??= (async () => {
      // Issue rejection created no authority. Revocation rejection must propagate.
      const authority = await this.issuing?.catch(() => undefined);
      if (authority) {
        await this.revokeGrant(authority.grant);
      }
    })();
    return this.closing;
  }
}

export type RunUploadLifetimeFactory = (scope: {
  readonly connectionId: string;
  readonly connectorId: string;
  readonly ownerId: string;
  readonly runId: string;
  readonly expiresAt: number;
}) => RunUploadLifetime;
