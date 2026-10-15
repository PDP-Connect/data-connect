# Vacuna al día on Moksha: data-gateway sequence

How the reminder service's paid reads reach Vana Moksha (chain 14800)
through the existing gateway `https://dp-rpc.moksha.vana.org`. Read from the
data-gateway source (`api/v1/**`, `lib/*.ts`) at commit `359596c`; nothing
was called live.

## Mapping

| Pilot | Gateway | Key |
|---|---|---|
| Reminder service | builder (grantee, payer, accessor) | `VACUNA_BUILDER_KEY_FILE` |
| Register (vaccination register) | each child's trusted server | per child, derived from `VACUNA_REGISTER_KEY_FILE` |
| Child | data owner, grantor | per child, derived from `VACUNA_CHILD_KEY_SEED_FILE` |
| Child's vaccination record | data point `keccak256(abi.encode(owner, scope))`, version 1 | |
| PDPP grant | grant `(child, builderId, [scope])`, `grantVersion` 1, `expiresAt` 0 | |
| One served weekly read | `POST /v1/escrow/pay` with an `accessRecord` | |

Scope: `dr.vacuna.child_immunizations` (same string for every child; the
owner makes the data point unique).

**One server key per child.** A server address belongs to exactly one owner
(`servers.server_address` is unique; `lib/servers.ts` returns 409/403 for a
second owner), and `RecordDataAccess` must be signed by a trusted server of
the data point's owner (`api/v1/escrow/pay.ts`, mirrored on chain). With
one owner per child, the register signs as each child's server under a key
derived from its root key: `keccak256(registerKey ‖ "vacuna/moksha/register-server/v1/<childId>#0")`.
Child owner keys: the same with the seed and `.../child-owner/v1/...`.

## EIP-712 domains

All: `{ name: "Vana Data Portability", version: "1", chainId: 14800, verifyingContract }`
(`lib/eip712.ts createDomain`). Header: `Authorization: Web3Signed <0x 65-byte sig>`.

| Endpoint | Primary type | verifyingContract |
|---|---|---|
| `POST /v1/builders` | `BuilderRegistration(address ownerAddress,address granteeAddress,string publicKey,string appUrl)` | DataPortabilityGrantees `0x8325C0A0948483EdA023A1A2Fd895e62C5131234` |
| `POST /v1/servers` | `ServerRegistration(address ownerAddress,address serverAddress,string publicKey,string serverUrl)` | DataPortabilityServer `0xCae2CE0e9caa6643ed28186cF57bd40Bd9E17Eab` |
| `POST /v1/data` | `AddData(address ownerAddress,string scope,bytes32 dataHash,bytes32 metadataHash,uint256 expectedVersion)` | DataRegistryV2 `0x8f1eFCdff3d0d5BB535e32620721c7EBed151867` |
| `POST /v1/grants` | `GrantRegistration(address grantorAddress,bytes32 granteeId,string[] scopes,uint256 grantVersion,uint256 expiresAt)` | DataPortabilityPermissions `0x4d3FA76064D88e0454cFc4CaD7e5FeC3e3124011` |
| `POST /v1/escrow/pay` | `GenericPayment(address payerAddress,string opType,bytes32 opId,address asset,uint256 amount,uint256 paymentNonce)` | DataPortabilityEscrow `0x07d7769081adc3a3DBe91f5E4B98E9A5a6B292e3` |
| `accessRecord.signature` | `RecordDataAccess(address ownerAddress,string scope,uint256 version,address accessor,bytes32 recordId)` | DataRegistryV2 (as AddData) |

The escrow address is from the pilot brief. The other four come from
data-gateway `.env.example`, which labels them Moksha; they are **not
verified against the live deployment**. A wrong one fails the first signed
POST with 401 and no side effect (`/v1/servers` returns
`details.recoveredSigner`).

## Sequence

Fees: FeeRegistry `0xb4FA18443E0FA6cdC0280D20b8cCDB2377D13Bf2`;
`data_access` 0.01 VANA, `grant_registration` 0.001 VANA, native asset
`0x0000000000000000000000000000000000000000`. Builder, server and data
registration fees must be **disabled**: with any of them enabled the
gateway answers 503 (no pay route for them yet).

Gas: every registration and payment is a gateway row that the gateway's
relayer settles on chain from its own wallet (cron `/v1/cron/settle`). The
only tx we pay gas for is the escrow deposit.

| # | Call | Signer | Body | Fee | Gas | Idempotency |
|---|---|---|---|---|---|---|
| 0 | `depositNative(builder)` on escrow, value 1 VANA | builder (sends the tx) | calldata `0x…` + value | none | builder | state keeps the tx hash; `--again` needed for a 2nd |
| 0b | `POST /v1/escrow/deposit` | none | `{ txHash }` | none | none | same hash → 200 with current state; 404 until the RPC sees the tx |
| 1 | `POST /v1/builders` | builder (owner = grantee = builder) | `{ ownerAddress, granteeAddress, publicKey: 0x04… uncompressed, appUrl: "" }` | disabled | relayer (`registerGrantee`) | 409 if the grantee exists → `GET /v1/builders/:address` → `data.id` |
| 2 | `POST /v1/servers` per child | child owner | `{ ownerAddress: child, serverAddress, publicKey, serverUrl }` | disabled | relayer | 409 → `GET /v1/servers/:address`, owner must match |
| 3 | `POST /v1/data` per child | the child's server key | `{ ownerAddress: child, scope, dataHash, metadataHash, expectedVersion: "1" }` | disabled | relayer (`addDataWithSignature`, deferred until the server is on chain) | 409 → `GET /v1/data/:dataPointId`; an unsubmitted v1 is refreshed in place (201) |
| 4 | `POST /v1/grants` per child | child owner | `{ grantorAddress: child, granteeId: builderId, scopes: [scope], grantVersion: "1", expiresAt: "0" }` | 0.001 VANA, due at step 5 | relayer (after the fee is paid) | `GET /v1/grants?user=<child>&builder=<builder>` first; 409 stale version → read back |
| 5 | `POST /v1/escrow/pay`, first read of a child | builder (`GenericPayment`) + child's server (`RecordDataAccess`) | `opType: "grant", opId: grantId, amount: 11000000000000000`, `accessRecord` | 0.011 VANA debited from escrow | relayer | same `accessRecord.recordId` + same signed fields → 200; anything else → 409 |
| 6 | `POST /v1/escrow/pay`, every later read | same | `opType: "data_access", opId: recordId, amount: 10000000000000000`, `accessRecord` | 0.01 VANA | relayer (`recordAccessAndSettle`, one tx per read) | as above |

Pay body (both forms):

```json
{ "payerAddress": "<builder>", "opType": "data_access", "opId": "<recordId>",
  "asset": "0x0000000000000000000000000000000000000000", "amount": "10000000000000000",
  "paymentNonce": "<unique per payer>",
  "accessRecord": { "dataPointId": "<keccak(owner,scope)>", "version": "1",
    "accessor": "<builder>", "recordId": "<read_id from the PDPP read receipt>",
    "signature": "<RecordDataAccess by the child's server>" } }
```

Why step 5 exists: a `data_access` payment needs a grant whose
`paymentStatus` is `paid`; with `grant_registration` enabled a new grant is
`pending`, and only an `opType: "grant"` payment flips it. That payment must
carry an `accessRecord` because `data_access` > 0, so it is the child's
first paid read (`registrationFee + dataAccessFee`).

What `/v1/escrow/pay` checks (`api/v1/escrow/pay.ts`): signer = payer; for
`data_access` `opId == recordId` and `accessor == payer`; data point exists,
is not deleted and has the signed version (pending is fine); for
`data_access` a grant from the data owner to the builder covering the scope,
paid, not revoked, not expired (pending/confirmed; confirmed is re-checked
on chain); RecordDataAccess signer is a non-revoked server of the owner;
`amount` equals the fee total exactly; `available = finalized balance −
unsettled payments − withdrawals ≥ amount` (else 402); nonce unused (else
409).

Error mapping in the Moksha payer: 402 (no finalized balance yet) and 403
on a `data_access` read while the child's grant payment is still pending
stay **retryable**; the reminder service resends them on its next run. Any
other 4xx is final for that body.

## Deposit: gasless or direct

`POST /v1/escrow/deposit-with-authorization` exists, but it is EIP-3009
(`receiveWithAuthorization` on an ERC-20) only
(`lib/deposit-authorization.ts`). The fee asset is native VANA, so the
deposit is a direct `depositNative(address account) payable` from the
builder, which pays value and gas, then `POST /v1/escrow/deposit { txHash }`.
The balance is credited when the tx's block is finalized; until then it
shows as `pendingAmount` in `GET /v1/escrow/balance`.

## Settlement and where to see it

- `GET /v1/escrow/balance?account=<builder>`: `balance` (finalized),
  `authorizedAmount` (paid, not yet debited), `availableAmount`.
- `GET /v1/grants?user=<child>&builder=<builder>`: grant `status`,
  `paymentStatus`, `settleTxHash`.
- No gateway endpoint returns a payment's settle tx. The relayer settles
  each paid read with `Escrow.recordAccessAndSettle(owner, scope, version,
  accessor, recordId, serverSignature, ops)`, emitting
  `Settled(from = builder, to = payee, ref = grantId, asset, amount, opKind = 5)`.
  The poller (`cli.ts poll`) filters those logs by `from` on the escrow,
  decodes `recordId` from each tx's calldata and marks that read settled.
  The grant fee settles as `opKind = 4` with `ref = grantId`.
- Explorer: `https://moksha.vanascan.io/tx/<hash>` and `/address/<addr>`.
  **Unverified**: no explorer URL appears in data-gateway docs or code.
- Moksha RPC for the poller and the deposit: `https://rpc.moksha.vana.org`.
  **Unverified**: data-gateway only names the mainnet RPC.

## Not covered

- Revocation mirror: a revoked PDPP grant is not mirrored to
  `DELETE /v1/grants/:grantId` (`GrantRevocation`, signed by the grantor).
- The data point stays at version 1; its hash commits to
  `abi.encode(scope, childId)`, not to the record contents, so record
  updates cost no relayer tx.
