// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Launch the reference server through its exported startServer() API so it
// binds to loopback only. The CLI entry point binds all interfaces, and the
// load-test instance runs without owner auth, so it must stay off the LAN.
import { startServer } from "../../../reference-implementation/server/index.ts";

const asPort = Number(process.env.AS_PORT || 7662);
const rsPort = Number(process.env.RS_PORT || 7663);

const quiet = process.env.VACUNA_SERVER_LOGS !== "1";
const server = await startServer({ asPort, bindHost: "127.0.0.1", quiet, rsPort });
console.log(`vacuna baseline server: AS http://127.0.0.1:${server.asPort} RS http://127.0.0.1:${server.rsPort}`);

const stop = () => {
  server.asServer.close();
  server.rsServer.close();
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
