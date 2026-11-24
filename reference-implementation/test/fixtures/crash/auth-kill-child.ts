// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Child for test/auth-kill-boundaries.test.ts. Opens the real storage named in
// argv[2] (a StorageSpec as JSON), does ONE piece of real auth work named by
// argv[3] with the JSON input in argv[4], and passes through the crash points
// compiled into server/auth.ts. The parent kills it at one of them.
import {
  approveGrant,
  consumeConsentExchangeCode,
  createConsentExchangeCode,
  createHostedMcpGrantPackage,
  exchangeOAuthAuthorizationCode,
  issueOAuthAuthorizationCodeForDeviceCode,
  revokeGrant,
  revokeGrantPackage,
} from "../../../server/auth.ts";
import { closeStorage, openStorage, type StorageSpec } from "../../helpers/auth-kill-fixture.ts";
import { armCrashPoints } from "../../helpers/crash-harness.ts";

armCrashPoints();

const spec = JSON.parse(process.argv[2] as string) as StorageSpec;
const op = process.argv[3] as string;
// biome-ignore lint/suspicious/noExplicitAny: the parent builds this input for the named op.
const input = JSON.parse(process.argv[4] ?? "{}") as any;

await openStorage(spec);
let result: unknown;
switch (op) {
  case "approve-consent":
    result = await approveGrant(input.deviceCode, "owner_local", {
      approval_review_revision: input.reviewRevision,
    });
    break;
  case "create-package":
    result = await createHostedMcpGrantPackage(input);
    break;
  case "issue-oauth-code":
    result = await issueOAuthAuthorizationCodeForDeviceCode(input.deviceCode, {
      grantId: input.grantId,
      token: input.token,
    });
    break;
  case "exchange-oauth-code":
    result = await exchangeOAuthAuthorizationCode(input);
    break;
  case "create-consent-exchange":
    result = await createConsentExchangeCode(input);
    break;
  case "consume-consent-exchange":
    result = await consumeConsentExchangeCode(input.code, input.proof);
    break;
  case "revoke-grant":
    result = await revokeGrant(input.grantId);
    break;
  case "revoke-package":
    result = await revokeGrantPackage(input.packageId);
    break;
  default:
    throw new Error(`unknown op: ${op}`);
}
await closeStorage(spec);
process.stdout.write(`finished ${op} ${JSON.stringify(result).length}\n`);
