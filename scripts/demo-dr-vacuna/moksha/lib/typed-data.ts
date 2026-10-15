// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// EIP-712 structs of the data-gateway registration endpoints, copied from
// data-gateway lib/eip712.ts. Every domain is
// { name: "Vana Data Portability", version: "1", chainId, verifyingContract }
// with the verifying contract named per endpoint (see SEQUENCE.md).

import { encodeAbiParameters, type Hex, keccak256, toHex } from "viem";

export {
  computeDataPointId,
  GENERIC_PAYMENT_TYPES,
  RECORD_DATA_ACCESS_TYPES,
  vanaDomain,
} from "../../reminder-service/lib/payer.ts";

export const BUILDER_REGISTRATION_TYPES = {
  BuilderRegistration: [
    { name: "ownerAddress", type: "address" },
    { name: "granteeAddress", type: "address" },
    { name: "publicKey", type: "string" },
    { name: "appUrl", type: "string" },
  ],
} as const;

export const SERVER_REGISTRATION_TYPES = {
  ServerRegistration: [
    { name: "ownerAddress", type: "address" },
    { name: "serverAddress", type: "address" },
    { name: "publicKey", type: "string" },
    { name: "serverUrl", type: "string" },
  ],
} as const;

export const GRANT_REGISTRATION_TYPES = {
  GrantRegistration: [
    { name: "grantorAddress", type: "address" },
    { name: "granteeId", type: "bytes32" },
    { name: "scopes", type: "string[]" },
    { name: "grantVersion", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const ADD_DATA_TYPES = {
  AddData: [
    { name: "ownerAddress", type: "address" },
    { name: "scope", type: "string" },
    { name: "dataHash", type: "bytes32" },
    { name: "metadataHash", type: "bytes32" },
    { name: "expectedVersion", type: "uint256" },
  ],
} as const;

/**
 * Version-1 commitment of a child's data point. The register's record keeps
 * changing; the demo does not re-register a version per change (each would
 * be a relayer tx), so the hash commits to the record's identity:
 * keccak256(abi.encode(scope, childId)).
 */
export function childDataHash(scope: string, childId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "scope", type: "string" },
        { name: "childId", type: "string" },
      ],
      [scope, childId]
    )
  );
}

export const METADATA_HASH: Hex = keccak256(toHex(JSON.stringify({ format: "pdpp-record", schema: "dr.vacuna.child_immunizations", v: 1 })));
