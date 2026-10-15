// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Moksha CLI for the "Vacuna al día" paid reads. See LIVE-RUNBOOK.md and
// SEQUENCE.md.
//
//   node cli.ts init-keys --dir DIR             three fresh 0600 key files (refuses to overwrite)
//   node cli.ts addresses [--count N | --children A,B]
//   node cli.ts register  [--count N | --children A,B]
//   node cli.ts deposit   --amount 1 [--again]   depositNative from the builder, then report it
//   node cli.ts balance
//   node cli.ts poll      [--watch --interval 30] [--from-block N]
//   node cli.ts status
//
// Network: loopback unless VACUNA_GATEWAY_ALLOWLIST / VACUNA_RPC_ALLOWLIST
// list the https origin. Keys: VACUNA_BUILDER_KEY_FILE,
// VACUNA_REGISTER_KEY_FILE, VACUNA_CHILD_KEY_SEED_FILE.

import { formatEther, parseEther } from "viem";
import { argInt, argValue } from "../baseline/lib/common.ts";
import { childId } from "../baseline/lib/dataset.ts";
import { explorerAddressUrl } from "./lib/config.ts";
import { buildContext } from "./lib/context.ts";
import { depositNative, readBalance } from "./lib/deposit.ts";
import { initKeyFiles } from "./lib/keys.ts";
import { pollSettlements, writeDashboard } from "./lib/settlement.ts";

function childList(): string[] {
  const explicit = argValue("children", "");
  if (explicit) {
    return explicit
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const n = argInt("count", 0);
  return Array.from({ length: n }, (_, i) => childId(i + 1));
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "init-keys") {
    const dir = argValue("dir", "");
    if (!dir) {
      throw new Error("init-keys needs --dir");
    }
    const paths = initKeyFiles(dir);
    console.log(`export VACUNA_BUILDER_KEY_FILE=${paths.builder}`);
    console.log(`export VACUNA_REGISTER_KEY_FILE=${paths.register}`);
    console.log(`export VACUNA_CHILD_KEY_SEED_FILE=${paths.childSeed}`);
    return;
  }
  const ctx = buildContext({});
  const { config, keys, log, registrar, state } = ctx;
  switch (cmd) {
    case "addresses": {
      console.log(JSON.stringify({ builder: keys.builder.address, builderUrl: explorerAddressUrl(config, keys.builder.address) }));
      for (const id of childList()) {
        console.log(JSON.stringify({ child: id, owner: keys.childOwner(id).address, server: keys.childServer(id).address }));
      }
      return;
    }
    case "register": {
      const ids = childList();
      const builderId = await registrar.ensureBuilder();
      log({ builder: keys.builder.address, builderId, event: "builder_ready" });
      for (const id of ids) {
        const c = await registrar.ensureChild(id);
        log({ child: id, dataPointId: c.dataPointId, event: "child_ready", grantId: c.grantId, grantPaid: c.grantPaid, serverId: c.serverId });
      }
      return;
    }
    case "deposit": {
      const amount = argValue("amount", "");
      if (!amount && !state.data.deposits.some((d) => !d.submittedToGateway)) {
        throw new Error("deposit needs --amount <VANA>");
      }
      const d = await depositNative(
        { config, gateway: ctx.gateway, keys, log, rpc: ctx.rpc, state },
        { again: process.argv.includes("--again"), amountWei: amount ? parseEther(amount) : 0n }
      );
      log({ amountVana: formatEther(BigInt(d.amountWei)), event: "deposit_state", gatewayStatus: d.gatewayStatus, txHash: d.txHash });
      return;
    }
    case "balance": {
      console.log(JSON.stringify(await readBalance({ config, gateway: ctx.gateway, keys, rpc: ctx.rpc }), null, 2));
      return;
    }
    case "poll": {
      const fromArg = argValue("from-block", process.env.VACUNA_MOKSHA_FROM_BLOCK || "");
      const once = async () =>
        pollSettlements(
          { config, gateway: ctx.gateway, keys, log, registrar, rpc: ctx.rpc, state },
          { fromBlock: fromArg ? BigInt(fromArg) : undefined }
        );
      await once();
      if (process.argv.includes("--watch")) {
        const intervalMs = argInt("interval", 30) * 1000;
        for (;;) {
          await new Promise((r) => setTimeout(r, intervalMs));
          await once().catch((err: Error) => log({ error: err.message, event: "poll_failed" }));
        }
      }
      return;
    }
    case "status": {
      console.log(JSON.stringify(writeDashboard(config, state), null, 2));
      return;
    }
    default:
      throw new Error(`unknown command ${cmd ?? "(none)"}; see the header of cli.ts`);
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
