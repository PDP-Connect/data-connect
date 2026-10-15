# Live dry run on Moksha (capped)

For a human operator. Two children, at most 10 paid reads, a 1 VANA escrow
deposit, through the live gateway `https://dp-rpc.moksha.vana.org` (chain
14800). The endpoints, signers, fees and gas behind each step are in
`SEQUENCE.md`. None of these commands has been run against Moksha yet.

Spend: one deposit of 1 VANA plus its gas. Out of the deposit, 2 × 0.011
(first read per child, which also pays the grant fee) + 6 × 0.01 = 0.082
VANA for 8 reads. The rest stays in escrow under the builder.

Caps (env, defaults shown): `VACUNA_MOKSHA_MAX_PAID_READS=10`,
`VACUNA_MOKSHA_MAX_CHILDREN=2`, `VACUNA_MOKSHA_MAX_DEPOSIT_WEI=2000000000000000000`.
Past the read cap the payer records the read as `capped` and sends nothing.

## 0. Prerequisites

- Node ≥ 22.18 (type stripping); repo dependencies installed and the
  workspace packages built as in `../baseline/README.md`.
- Docker for the local PDPP Postgres (`../baseline/db.sh`).
- Testnet VANA for the builder address only (≈ 1.05 VANA). Child and
  register keys never send transactions.

All commands below run from `scripts/demo-dr-vacuna/`.

## 1. Keys (throwaway, testnet only)

```sh
mkdir -p ~/.config/dr-vacuna && chmod 700 ~/.config/dr-vacuna
node moksha/cli.ts init-keys --dir ~/.config/dr-vacuna
# prints three export lines; run them:
export VACUNA_BUILDER_KEY_FILE=~/.config/dr-vacuna/builder.key
export VACUNA_REGISTER_KEY_FILE=~/.config/dr-vacuna/register.key
export VACUNA_CHILD_KEY_SEED_FILE=~/.config/dr-vacuna/child-seed.key
```

The files are 0600 and the CLI refuses group/other-readable ones. Keys are
never printed, logged or written to state.

## 2. Point at Moksha (explicit allowlists)

```sh
export VACUNA_GATEWAY_URL=https://dp-rpc.moksha.vana.org
export VACUNA_GATEWAY_ALLOWLIST=https://dp-rpc.moksha.vana.org
export VACUNA_RPC_URL=https://rpc.moksha.vana.org          # unverified URL, see SEQUENCE.md
export VACUNA_RPC_ALLOWLIST=https://rpc.moksha.vana.org
export VACUNA_MOKSHA_STATE_DIR=$PWD/moksha/.state
node moksha/cli.ts addresses --count 2
```

Expect one `builder` line (address + explorer URL) and one line per child
(`DR-0000001`, `DR-0000002`) with its owner and server addresses. Fund the
**builder** address with ≈ 1.05 VANA from the Moksha faucet.

Without the two `*_ALLOWLIST` variables every command refuses the remote
URLs; with them unset entirely it talks to loopback only.

## 3. Deposit 1 VANA into escrow

```sh
node moksha/cli.ts deposit --amount 1
node moksha/cli.ts balance
```

Expect `deposit_broadcast` with a tx hash, then `deposit_reported` with
`status: "submitted"` (or `finalized`). `balance` shows `pendingAmount`
1000000000000000000 until the block is finalized, then `balance` and
`availableAmount` 1000000000000000000 and `paidReadsAffordable: "100"`.
Rerun `balance` until the balance is finalized; pay is refused (402) before
that. Rerunning `deposit` never sends a second tx unless `--again` is given;
if the gateway did not see the tx yet, rerunning `deposit` only reports the
stored hash again.

Check: `https://moksha.vanascan.io/tx/<txHash>` is a call to
`0x07d7769081adc3a3DBe91f5E4B98E9A5a6B292e3` (`depositNative`) with value 1
VANA from the builder.

## 4. Register builder and the two children

```sh
node moksha/cli.ts register --count 2
```

Expect `builder_registered` (HTTP 201) then, per child, `server_registered`,
`data_point_registered`, `grant_registered` and `child_ready` with
`grantPaid: false`. Rerunning prints `child_ready` again and posts nothing.

**Stop on any 401.** It means an EIP-712 domain does not match the live
deployment: the four contract addresses other than the escrow come from
data-gateway `.env.example`, not from the live gateway. Override with
`VACUNA_GRANTEES_CONTRACT`, `VACUNA_SERVERS_CONTRACT`,
`VACUNA_DATA_REGISTRY_CONTRACT`, `VACUNA_PERMISSIONS_CONTRACT`. A 401
writes nothing.

**Stop on a 503** from `/v1/builders`, `/v1/servers` or `/v1/data`: a
registration fee other than `grant_registration` is enabled on the
FeeRegistry, which the gateway cannot take payment for yet.

Check the fee schedule the gateway will charge (no auth):

```sh
curl -s "$VACUNA_GATEWAY_URL/v1/grants?user=<child owner>&builder=<builder>" | jq '.data.grants[0] | {status, paymentStatus, fee}'
```

Expect `paymentStatus: "pending"` and `fee.registrationFee` 1000000000000000,
`fee.dataAccessFee` 10000000000000000, `fee.totalDue` 11000000000000000. If
they differ, set `VACUNA_GRANT_REGISTRATION_FEE_WEI` / `VACUNA_DATA_ACCESS_FEE_WEI`
to match before any read (a wrong amount is refused with 400, nothing is
charged).

## 5. Local register (PDPP server) and reminder service

```sh
export PDPP_RS_INTROSPECTION_CLIENT_ID=rs-local
export PDPP_RS_INTROSPECTION_CLIENT_SECRET=$(openssl rand -hex 16)
(cd baseline && ./db.sh up)
(cd baseline && PDPP_CONFIDENTIAL_CLIENTS=1 PDPP_READ_RECEIPTS=1 \
  PDPP_READ_RECEIPTS_KEY_FILE=$PWD/.state/read-receipts.pem ./start-server.sh) &
cd reminder-service
node cli.ts bootstrap --children 2 --ingest
```

Expect two children with real auth-code grants (`DR-0000001`, `DR-0000002`,
the same ids `register --count 2` used).

## 6. Paid reads: 4 simulated weeks = 8 paid reads

```sh
for d in 2026-10-19 2026-10-26 2026-11-02 2026-11-09; do
  node cli.ts week --payer moksha --now ${d}T08:00:00Z \
    --receipt-public-key ../baseline/.state/read-receipts.pem.pub
done
node cli.ts counters
```

Per week expect `payments.accepted` +2. Week 1 sends `opType: "grant"`
(0.011 VANA) per child, which flips that child's grant to paid; weeks 2–4
send `opType: "data_access"` (0.01 VANA). A child not yet registered is
registered right before its first payment (the hook), so step 4 is
optional, but running it first lets the registrations settle earlier.

A payment answered 402 (balance not final) or 403 while that child's grant
payment is pending is kept and resent by `node cli.ts daily --payer moksha
--now …`. Any other refusal is final and logged as `payment_rejected`.

## 7. Settlement and verification

```sh
cd ..
node moksha/cli.ts poll                 # once
node moksha/cli.ts poll --watch --interval 60   # until every read is settled
node moksha/cli.ts balance
```

`poll` writes `moksha/.state/settlements.json`: one row per paid read with
`status` (`accepted` → `settled`), `settleTxHash` and `explorerUrl`, plus
each child's grant status and grant tx. On a fresh state dir it scans the
last 20,000 blocks; set `VACUNA_MOKSHA_FROM_BLOCK` to the deposit's block to
scan less.

Expect, once the relayer has drained (minutes; it runs every cron minute):

- 8 rows `settled`, each `explorerUrl` a `recordAccessAndSettle` call on the
  escrow from the gateway relayer, with a `Settled` log whose `from` is the
  builder, `ref` the child's grantId, `amount` 10000000000000000 and
  `opKind` 5;
- 2 grant registration settlements (`opKind` 4, 1000000000000000 each)
  listed under `poll.unmatchedSettlements` in the state file (they are not
  reads), and each child's `grantStatus` `confirmed` or `finalized`;
- `balance`: `balance` 1000000000000000000 − 82000000000000000 =
  918000000000000000 once all are debited, `authorizedAmount` 0.

On the explorer (unverified host `https://moksha.vanascan.io`):
`/address/<builder>` shows the deposit; `/address/0x07d7769081adc3a3DBe91f5E4B98E9A5a6B292e3`
shows the relayer's `recordAccessAndSettle` txs.

## 8. Stop

Stop the PDPP server you started in step 5 (its job: `kill %1` in that
shell) and `(cd baseline && ./db.sh stop)`. The unspent escrow balance can
be withdrawn later with `POST /v1/escrow/withdraw` (not wired here).
